import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitForServer(base, child, output) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    if (child.exitCode !== null) throw new Error(`Server exited: ${output()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start: ${output()}`);
}

test("password, device upload, live view, and private archive", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "officecam-test-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve("."),
    env: { ...process.env, PORT: String(port), STORAGE_DIR: directory, SITE_PASSWORD: "test-password", SESSION_SECRET: "session-secret", DEVICE_TOKEN: "device-secret", BUCKET_NAME: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(async () => { child.kill(); await rm(directory, { recursive: true, force: true }); });
  await waitForServer(base, child, () => output);

  const page = await fetch(base);
  assert.match(page.headers.get("content-security-policy"), /img-src[^;]*blob:/);

  assert.equal((await fetch(`${base}/api/overview`)).status, 401);
  const wrong = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ password: "wrong" }) });
  assert.equal(wrong.status, 401);
  const login = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ password: "test-password" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const viewer = { Cookie: cookie };
  const device = { Authorization: "Bearer device-secret" };

  const status = await fetch(`${base}/api/device/status`, { headers: device });
  assert.equal((await status.json()).stream, false);
  assert.equal((await fetch(`${base}/api/live`, { headers: viewer })).status, 503);
  const active = await fetch(`${base}/api/device/status`, { headers: device });
  assert.equal((await active.json()).stream, true);

  const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]);
  assert.equal((await fetch(`${base}/api/device/live`, { method: "POST", headers: device, body: tinyJpeg })).status, 200);
  const live = await fetch(`${base}/api/live`, { headers: viewer });
  assert.equal(live.status, 200);
  assert.deepEqual(Buffer.from(await live.arrayBuffer()), tinyJpeg);

  const at = new Date();
  at.setUTCMinutes(0, 0, 0);
  const captureAt = at.toISOString();
  const upload = await fetch(`${base}/api/device/photo`, { method: "POST", headers: { ...device, "X-Captured-At": captureAt }, body: tinyJpeg });
  assert.equal(upload.status, 200);
  const month = captureAt.slice(0, 7);
  const overview = await fetch(`${base}/api/overview`, { headers: viewer });
  assert.deepEqual((await overview.json()).months, [month]);
  const photos = await fetch(`${base}/api/photos?month=${month}`, { headers: viewer });
  const list = (await photos.json()).photos;
  assert.equal(list.length, 1);
  assert.equal(list[0].at, captureAt);
  assert.equal((await fetch(`${base}/api/photo?key=${encodeURIComponent(list[0].key)}`)).status, 401);
  assert.equal((await fetch(`${base}/api/photo?key=${encodeURIComponent(list[0].key)}`, { headers: viewer })).status, 200);
  const video = await fetch(`${base}/api/video/status?month=${month}`, { headers: viewer });
  assert.deepEqual((await video.json()).state, "needed");
  const stamp = path.basename(list[0].key, ".jpg");
  const videoFolder = path.join(directory, "videos", month);
  await mkdir(videoFolder, { recursive: true });
  await writeFile(path.join(videoFolder, `${stamp}.mp4`), Buffer.from("abcdef"));
  const clip = await fetch(`${base}/api/video/file?month=${month}`, { headers: { ...viewer, Range: "bytes=1-3" } });
  assert.equal(clip.status, 206);
  assert.equal(clip.headers.get("content-range"), "bytes 1-3/6");
  assert.equal(await clip.text(), "bcd");
});
