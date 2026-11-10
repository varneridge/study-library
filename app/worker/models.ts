// Kokoro's model files, served from this Worker's own origin.
//
// The browser could not fetch the model from huggingface.co or hf-mirror.com,
// because their responses reached it without an Access-Control-Allow-Origin
// header. A request the Worker makes to Hugging Face is server to server, so
// CORS never applies to it, and the page then fetches the file from its own
// origin, where CORS does not apply either.
//
// The first request for a file fetches it from Hugging Face and keeps a copy in
// R2 under models/; every later request, from any device, is served from R2.
// Only the one Kokoro repository can be requested, so this is not an open proxy.

import type { Env } from "./env";
import { serveObject } from "./files";

/** The only repository and revision served, as transformers.js requests them. */
const ALLOWED = /^onnx-community\/Kokoro-82M-v1\.0-ONNX\/resolve\/main\/[A-Za-z0-9_.\-/]+$/;

const UPSTREAM = "https://huggingface.co/";

export async function serveModelFile(env: Env, path: string, request: Request): Promise<Response> {
  if (!ALLOWED.test(path) || path.includes("..")) return new Response("Not found", { status: 404 });
  const key = `models/${path}`;
  if (!(await env.BUCKET.head(key))) {
    const upstream = await fetch(`${UPSTREAM}${path}`, { redirect: "follow" });
    // A file the model does not have (transformers.js asks for some optional
    // ones) is passed on as a 404, which it treats as absent, not as a failure.
    if (upstream.status === 404) return new Response("Not found", { status: 404 });
    if (!upstream.ok || !upstream.body) return new Response(`Hugging Face answered ${upstream.status}`, { status: 502 });
    const length = Number(upstream.headers.get("content-length"));
    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    if (Number.isFinite(length) && length > 0) {
      // A fixed length lets R2 take the stream directly, so a 300 MB model is never held in memory.
      const sized = new FixedLengthStream(length);
      const stored = env.BUCKET.put(key, sized.readable, { httpMetadata: { contentType } });
      await Promise.all([upstream.body.pipeTo(sized.writable), stored]);
    } else {
      // Small files sometimes come without a length; those are buffered.
      await env.BUCKET.put(key, await upstream.arrayBuffer(), { httpMetadata: { contentType } });
    }
  }
  return serveObject(env, key, request);
}
