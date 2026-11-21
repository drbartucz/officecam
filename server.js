import http from "node:http";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { createStorage } from "./storage.js";

const password = process.env.SITE_PASSWORD;
const sessionSecret = process.env.SESSION_SECRET;
const deviceToken = process.env.DEVICE_TOKEN;
if (!password || !sessionSecret || !deviceToken) {
  throw new Error("SITE_PASSWORD, SESSION_SECRET, and DEVICE_TOKEN are required");
}
const storage = await createStorage();
const port = Number(process.env.PORT || 3000);
const jobs = new Map();
const loginAttempts = new Map();
let liveFrame = null;
let liveAt = 0;
let lastViewerAt = 0;
let lastPhotoAt = null;

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}
function text(res, code, message) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(message);
}
function hash(value) { return createHash("sha256").update(value).digest(); }
function equalSecret(a, b) { return timingSafeEqual(hash(a), hash(b)); }
function cookie(req, name) {
  const item = (req.headers.cookie || "").split(";").map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : "";
}
function signedSession(expiry) {
  const value = String(expiry);
  const signature = createHmac("sha256", sessionSecret).update(value).digest("hex");
  return `${value}.${signature}`;
}
function isLoggedIn(req) {
  const value = cookie(req, "officecam_session");
  const [expiry, signature] = value.split(".");
  if (!/^\d+$/.test(expiry || "") || !/^[a-f0-9]{64}$/.test(signature || "")) return false;
  if (Number(expiry) < Date.now()) return false;
  return equalSecret(signedSession(expiry), value);
}
function isDevice(req) {
  const token = req.headers.authorization?.replace(/^Bearer /, "") || "";
  return equalSecret(token, deviceToken);
}
function requireLogin(req, res) { if (isLoggedIn(req)) return true; json(res, 401, { error: "Password required" }); return false; }
function requireDevice(req, res) { if (isDevice(req)) return true; json(res, 401, { error: "Invalid device token" }); return false; }
async function body(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Upload too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function jpeg(bytes) { return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9; }
function monthFromQuery(url) {
  const month = url.searchParams.get("month") || "";
  return month === "all" || /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : null;
}
function keyForCapture(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== iso || date.getUTCMinutes() || date.getUTCSeconds() || date.getUTCMilliseconds()) return null;
  if (date.valueOf() > Date.now() + 300_000 || date.valueOf() < Date.UTC(2020, 0, 1)) return null;
  return `photos/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(0, 13)}-00-00Z.jpg`;
}
async function photoKeys(month) {
  if (month === "all") {
    return (await storage.list("photos/")).keys.sort();
  }
  const prefix = `photos/${month.slice(0, 4)}/${month.slice(5, 7)}/`;
  return (await storage.list(prefix)).keys.sort();
}
async function availableMonths() {
  const years = (await storage.list("photos/", "/")).prefixes;
  const months = (await Promise.all(years.map((year) => storage.list(year, "/")))).flatMap((result) => result.prefixes);
  return months.map((prefix) => `${prefix.slice(7, 11)}-${prefix.slice(12, 14)}`).sort().reverse();
}
function videoKey(month, lastPhoto) {
  const stamp = path.basename(lastPhoto, ".jpg");
  return `videos/${month}/${stamp}.mp4`;
}
async function videoState(month) {
  const photos = await photoKeys(month);
  if (!photos.length) return { state: "empty", count: 0 };
  const key = videoKey(month, photos.at(-1));
  if (await storage.exists(key)) return { state: "ready", count: photos.length, url: `/api/video/file?month=${month}` };
  const job = jobs.get(key);
  if (job) return { state: job.state, count: photos.length, error: job.error };
  return { state: "needed", count: photos.length };
}
async function createVideo(key, photos) {
  const folder = await mkdtemp(path.join(tmpdir(), "officecam-"));
  const output = path.join(folder, "timelapse.mp4");
  const child = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", "24", "-vcodec", "mjpeg", "-i", "pipe:0",
    "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output,
  ], { stdio: ["pipe", "ignore", "pipe"] });
  let errorText = "";
  child.stderr.on("data", (chunk) => { errorText = (errorText + chunk.toString()).slice(-2000); });
  child.stdin.on("error", () => {});
  const finished = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${errorText}`)));
  });
  finished.catch(() => {});
  try {
    for (const photo of photos) {
      const object = await storage.get(photo);
      if (!object) throw new Error(`Missing photo ${photo}`);
      for await (const chunk of object.body) {
        if (child.exitCode !== null) throw new Error(`ffmpeg stopped before reading ${photo}: ${errorText}`);
        if (!child.stdin.write(chunk)) await Promise.race([
          once(child.stdin, "drain"),
          finished.then(() => { throw new Error("ffmpeg closed before all photos were sent"); }),
        ]);
      }
    }
    child.stdin.end();
    await finished;
    await storage.putFile(key, output, "video/mp4");
    const prefix = key.slice(0, key.lastIndexOf("/") + 1);
    const older = (await storage.list(prefix)).keys.filter((item) => item !== key);
    await Promise.all(older.map((item) => storage.delete(item)));
  } catch (error) {
    child.kill();
    child.stdin.destroy();
    await finished.catch(() => {});
    throw error;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
function startVideo(month, res) {
  photoKeys(month).then(async (photos) => {
    if (!photos.length) return json(res, 404, { error: "No photos yet" });
    const key = videoKey(month, photos.at(-1));
    if (await storage.exists(key)) return json(res, 200, { state: "ready" });
    if (!jobs.has(key) || jobs.get(key).state === "failed") {
      const job = { state: "building", error: null };
      jobs.set(key, job);
      createVideo(key, photos).then(() => { job.state = "ready"; }, (error) => {
        job.state = "failed"; job.error = error.message;
        console.error("Video build failed", error);
      });
    }
    json(res, 202, { state: "building", count: photos.length });
  }).catch((error) => { console.error(error); json(res, 500, { error: "Could not start video" }); });
}
async function sendObject(req, res, key, contentType) {
  const range = contentType === "video/mp4" ? req.headers.range : undefined;
  const object = await storage.get(key, range);
  if (!object) return text(res, 404, "Not found");
  const headers = { "Content-Type": contentType, "Cache-Control": "private, max-age=300", "Accept-Ranges": contentType === "video/mp4" ? "bytes" : "none" };
  if (object.length) headers["Content-Length"] = object.length;
  if (object.contentRange) headers["Content-Range"] = object.contentRange;
  res.writeHead(object.contentRange ? 206 : 200, headers);
  await pipeline(object.body, res);
}
async function staticFile(res, filename, contentType) {
  const bytes = await readFile(new URL(`./public/${filename}`, import.meta.url));
  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "public, max-age=3600" });
  res.end(bytes);
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'");
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") return text(res, 200, "ok");
    if (req.method === "GET" && url.pathname === "/") return staticFile(res, "index.html", "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/app.css") return staticFile(res, "app.css", "text/css; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/app.js") return staticFile(res, "app.js", "text/javascript; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/session") return json(res, 200, { authenticated: isLoggedIn(req) });
    if (req.method === "POST" && url.pathname === "/api/login") {
      const ip = req.headers["x-real-ip"] || req.socket.remoteAddress || "unknown";
      const attempt = loginAttempts.get(ip) || { count: 0, until: 0 };
      if (attempt.until > Date.now()) return json(res, 429, { error: "Too many attempts. Try again later." });
      const input = JSON.parse((await body(req, 1024)).toString());
      if (!equalSecret(String(input.password || ""), password)) {
        attempt.count += 1;
        if (attempt.count >= 8) { attempt.until = Date.now() + 15 * 60_000; attempt.count = 0; }
        loginAttempts.set(ip, attempt);
        return json(res, 401, { error: "Incorrect password" });
      }
      loginAttempts.delete(ip);
      const expiry = Date.now() + 30 * 24 * 60 * 60_000;
      res.setHeader("Set-Cookie", `officecam_session=${signedSession(expiry)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);
      return json(res, 200, { authenticated: true });
    }
    if (req.method === "POST" && url.pathname === "/api/logout") {
      res.setHeader("Set-Cookie", "officecam_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
      return json(res, 200, { authenticated: false });
    }
    if (req.method === "GET" && url.pathname === "/api/device/status") {
      if (!requireDevice(req, res)) return;
      return json(res, 200, { stream: Date.now() - lastViewerAt < 10_000 });
    }
    if (req.method === "POST" && url.pathname === "/api/device/live") {
      if (!requireDevice(req, res)) return;
      const bytes = await body(req, 1_000_000);
      if (!jpeg(bytes)) return json(res, 400, { error: "JPEG required" });
      liveFrame = bytes; liveAt = Date.now();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/device/photo") {
      if (!requireDevice(req, res)) return;
      const key = keyForCapture(req.headers["x-captured-at"] || "");
      if (!key) return json(res, 400, { error: "Capture time must be a UTC hour" });
      const bytes = await body(req, 8_000_000);
      if (!jpeg(bytes)) return json(res, 400, { error: "JPEG required" });
      if (!(await storage.exists(key))) await storage.put(key, bytes, "image/jpeg");
      lastPhotoAt = req.headers["x-captured-at"];
      return json(res, 200, { ok: true, key });
    }
    if (!requireLogin(req, res)) return;
    if (req.method === "GET" && url.pathname === "/api/live") {
      lastViewerAt = Date.now();
      if (!liveFrame || Date.now() - liveAt > 10_000) return json(res, 503, { error: "Camera offline or starting" });
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "Content-Length": liveFrame.length, "X-Frame-Time": new Date(liveAt).toISOString() });
      return res.end(liveFrame);
    }
    if (req.method === "GET" && url.pathname === "/api/overview") {
      const months = await availableMonths();
      return json(res, 200, { months, lastPhotoAt, liveAt: liveAt ? new Date(liveAt).toISOString() : null });
    }
    if (req.method === "GET" && url.pathname === "/api/photos") {
      const month = monthFromQuery(url);
      if (!month) return json(res, 400, { error: "Invalid month" });
      const photos = await photoKeys(month);
      return json(res, 200, { photos: photos.map((key) => ({ key, at: path.basename(key, ".jpg").replace("-00-00Z", ":00:00.000Z") })) });
    }
    if (req.method === "GET" && url.pathname === "/api/photo") {
      const key = url.searchParams.get("key") || "";
      if (!/^photos\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}T\d{2}-00-00Z\.jpg$/.test(key)) return text(res, 400, "Invalid photo");
      return sendObject(req, res, key, "image/jpeg");
    }
    if (url.pathname === "/api/video/status" && req.method === "GET") {
      const month = monthFromQuery(url);
      if (!month) return json(res, 400, { error: "Invalid month" });
      return json(res, 200, await videoState(month));
    }
    if (url.pathname === "/api/video" && req.method === "POST") {
      const month = monthFromQuery(url);
      if (!month) return json(res, 400, { error: "Invalid month" });
      return startVideo(month, res);
    }
    if (url.pathname === "/api/video/file" && req.method === "GET") {
      const month = monthFromQuery(url);
      if (!month) return json(res, 400, { error: "Invalid month" });
      const photos = await photoKeys(month);
      if (!photos.length) return text(res, 404, "No photos");
      return sendObject(req, res, videoKey(month, photos.at(-1)), "video/mp4");
    }
    return text(res, 404, "Not found");
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : "Server error" });
    else res.destroy(error);
  }
});

server.listen(port, "0.0.0.0", () => console.log(`Officecam listening on ${port}`));
