import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const validKey = (key) => /^[a-zA-Z0-9_./-]+$/.test(key) && !key.split("/").includes("..");

export async function createStorage() {
  const bucket = process.env.BUCKET_NAME;
  if (!bucket) return localStorage(path.resolve(process.env.STORAGE_DIR || "data"));

  const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command } =
    await import("@aws-sdk/client-s3");
  const { Upload } = await import("@aws-sdk/lib-storage");
  const client = new S3Client({
    region: process.env.BUCKET_REGION || "auto",
    endpoint: process.env.BUCKET_ENDPOINT,
    forcePathStyle: process.env.BUCKET_URL_STYLE === "path",
    credentials: {
      accessKeyId: process.env.BUCKET_ACCESS_KEY_ID,
      secretAccessKey: process.env.BUCKET_SECRET_ACCESS_KEY,
    },
  });

  return {
    async put(key, body, contentType) {
      if (!validKey(key)) throw new Error("Invalid storage key");
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async putFile(key, file, contentType) {
      if (!validKey(key)) throw new Error("Invalid storage key");
      const upload = new Upload({ client, params: { Bucket: bucket, Key: key, Body: createReadStream(file), ContentType: contentType } });
      await upload.done();
    },
    async get(key, range) {
      if (!validKey(key)) throw new Error("Invalid storage key");
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }));
        return { body: object.Body, length: object.ContentLength, contentType: object.ContentType, contentRange: object.ContentRange };
      } catch (error) {
        if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) return null;
        if (error.$metadata?.httpStatusCode === 416) throw Object.assign(new Error("Invalid byte range"), { status: 416 });
        throw error;
      }
    },
    async exists(key) {
      if (!validKey(key)) throw new Error("Invalid storage key");
      try { await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; }
      catch (error) { if (error.$metadata?.httpStatusCode === 404) return false; throw error; }
    },
    async delete(key) {
      if (!validKey(key)) throw new Error("Invalid storage key");
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async list(prefix, delimiter = "") {
      const keys = [];
      const prefixes = [];
      let token;
      do {
        const page = await client.send(new ListObjectsV2Command({
          Bucket: bucket, Prefix: prefix, Delimiter: delimiter || undefined, ContinuationToken: token,
        }));
        keys.push(...(page.Contents || []).map((item) => item.Key));
        prefixes.push(...(page.CommonPrefixes || []).map((item) => item.Prefix));
        token = page.NextContinuationToken;
      } while (token);
      return { keys, prefixes };
    },
  };
}

function localStorage(root) {
  function filePath(key) {
    if (!validKey(key)) throw new Error("Invalid storage key");
    return path.join(root, ...key.split("/"));
  }
  return {
    async put(key, body) {
      const file = filePath(key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, body);
    },
    async putFile(key, file) {
      const destination = filePath(key);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(file, destination);
    },
    async get(key, range) {
      const file = filePath(key);
      try {
        const info = await stat(file);
        if (!range) return { body: createReadStream(file), length: info.size };
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) throw Object.assign(new Error("Invalid byte range"), { status: 416 });
        const start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
        const end = match[1] && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
          throw Object.assign(new Error("Invalid byte range"), { status: 416 });
        }
        return { body: createReadStream(file, { start, end }), length: end - start + 1, contentRange: `bytes ${start}-${end}/${info.size}` };
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async exists(key) {
      try { await stat(filePath(key)); return true; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    },
    async delete(key) { await rm(filePath(key), { force: true }); },
    async list(prefix, delimiter = "") {
      const keys = [];
      const prefixes = new Set();
      async function walk(dir, relative = "") {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); }
        catch (error) { if (error.code === "ENOENT") return; throw error; }
        for (const entry of entries) {
          const key = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(path.join(dir, entry.name), key);
          else if (key.startsWith(prefix)) {
            const rest = key.slice(prefix.length);
            const at = delimiter ? rest.indexOf(delimiter) : -1;
            if (at >= 0) prefixes.add(prefix + rest.slice(0, at + 1));
            else keys.push(key);
          }
        }
      }
      await walk(root);
      return { keys: keys.sort(), prefixes: [...prefixes].sort() };
    },
  };
}
