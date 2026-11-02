// Module cover pictures and user-uploaded pictures.
// Stored in R2 under pictures/<sha256>.<ext>, capped at 512 KB,
// and served with immutable caching.

import type { Env } from "./env";
import { serveObject } from "./files";

const PICTURE_FILENAME = /^[0-9a-f]{64}\.(webp|jpe?g|png)$/;
const MAX_PICTURE_BYTES = 512 * 1024; // 512 KB
const ALLOWED_MIME = ["image/webp", "image/jpeg", "image/png"];

export async function storePicture(
  env: Env,
  request: Request,
  filename: string,
): Promise<{ key: string; existed: boolean }> {
  if (!PICTURE_FILENAME.test(filename)) {
    throw new Error("invalid picture filename");
  }
  const key = `pictures/${filename}`;
  if (await env.BUCKET.head(key)) {
    if (request.body) await request.body.cancel();
    return { key, existed: true };
  }

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_MIME.includes(contentType)) {
    throw new Error(`unsupported picture type ${contentType || "(none)"}`);
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new Error("empty picture upload");
  }
  if (buffer.byteLength > MAX_PICTURE_BYTES) {
    throw new Error("picture exceeds 512 KB limit");
  }

  // Verify SHA-256 matches filename
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const actualSha = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  const expectedSha = filename.split(".")[0];
  if (actualSha !== expectedSha) {
    throw new Error("picture content hash mismatch");
  }

  await env.BUCKET.put(key, buffer, { httpMetadata: { contentType } });
  return { key, existed: false };
}

export async function servePicture(env: Env, filename: string, request?: Request): Promise<Response> {
  if (!PICTURE_FILENAME.test(filename)) {
    return new Response("Not found", { status: 404 });
  }
  return serveObject(env, `pictures/${filename}`, request);
}
