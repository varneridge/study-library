import { NOW, TOUCH, type Env } from "./env";

export const EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/msword": ".doc",
  "audio/webm": ".webm",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/aac": ".aac",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  // Answers to application questions, in the job search.
  "text/plain": ".txt",
  // Pictures in notes. SVG is left out, because it can carry scripts.
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export function contentType(request: Request): string {
  return (request.headers.get("content-type") ?? "").split(";")[0].trim();
}

const SHA256 = /^[0-9a-f]{64}$/;

export function jobTypeFor(mime: string): string | null {
  if (mime === "application/pdf") return "extract_text";
  if (EXTENSIONS[mime] && /officedocument|ms-powerpoint|msword/.test(mime)) return "convert";
  return null;
}

// Files are stored by content hash, so uploading the same file twice is free.
export async function storeUpload(env: Env, request: Request, sha: string): Promise<{ key: string; existed: boolean }> {
  if (!SHA256.test(sha)) throw new Error("expected a lowercase sha256 hex digest");
  const mime = contentType(request);
  const extension = EXTENSIONS[mime];
  if (!extension) throw new Error(`unsupported file type ${mime || "(none)"}`);
  if (!request.body) throw new Error("empty upload");

  const key = `files/${sha}${extension}`;
  if (await env.BUCKET.head(key)) {
    await request.body.cancel();
    return { key, existed: true };
  }
  await env.BUCKET.put(key, request.body, { httpMetadata: { contentType: mime } });
  return { key, existed: false };
}

// Serves a stored file. Range requests let audio players seek.
// A file's own name for the browser to show and save it under. The stored
// name is its hash, which means nothing to a person.
function withName(response: Response, name: string | null): Response {
  if (!name || !response.ok) return response;
  const safe = name.replace(/[\r\n"\\]/g, "").slice(0, 200) || "file";
  response.headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(safe)}`);
  return response;
}

export async function serveObject(env: Env, key: string, request?: Request): Promise<Response> {
  const name = request ? new URL(request.url).searchParams.get("name") : null;
  return withName(await serveObjectBody(env, key, request), name);
}

async function serveObjectBody(env: Env, key: string, request?: Request): Promise<Response> {
  const range = parseRange(request?.headers.get("range") ?? null);
  if (range) {
    const head = await env.BUCKET.head(key);
    if (!head) return new Response("Not found", { status: 404 });
    const start = range.start ?? Math.max(0, head.size - (range.suffix ?? 0));
    const end = Math.min(range.end ?? head.size - 1, head.size - 1);
    if (start >= head.size || start > end) {
      return new Response("Range not satisfiable", { status: 416, headers: { "content-range": `bytes */${head.size}` } });
    }
    const object = await env.BUCKET.get(key, { range: { offset: start, length: end - start + 1 } });
    if (!object) return new Response("Not found", { status: 404 });
    const headers = baseHeaders(object);
    headers.set("content-range", `bytes ${start}-${end}/${head.size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(object.body, { status: 206, headers });
  }
  const object = await env.BUCKET.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = baseHeaders(object);
  headers.set("content-length", String(object.size));
  return new Response(object.body, { headers });
}

function baseHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  // Keys never point at different content, so devices can cache for good.
  headers.set("cache-control", "private, max-age=31536000, immutable");
  return headers;
}

function parseRange(header: string | null): { start?: number; end?: number; suffix?: number } | null {
  const match = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) return { suffix: Number(match[2]) };
  return { start: Number(match[1]), end: match[2] ? Number(match[2]) : undefined };
}

// Large files go up in parts of up to 50 MB, because a single Worker
// request is limited to 100 MB. Finished parts survive a dropped connection.
export async function startUpload(env: Env, sha: string, mime: string) {
  if (!SHA256.test(sha)) throw new Error("expected a lowercase sha256 hex digest");
  const extension = EXTENSIONS[mime];
  if (!extension) throw new Error(`unsupported file type ${mime || "(none)"}`);
  const key = `files/${sha}${extension}`;
  if (await env.BUCKET.head(key)) return { key, existed: true as const };
  const upload = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: mime } });
  return { key, existed: false as const, upload_id: upload.uploadId };
}

export async function uploadPart(env: Env, key: string, uploadId: string, part: number, request: Request) {
  if (!key.startsWith("files/")) throw new Error("bad key");
  if (!request.body) throw new Error("empty part");
  const uploaded = await env.BUCKET.resumeMultipartUpload(key, uploadId).uploadPart(part, request.body);
  return { part_number: uploaded.partNumber, etag: uploaded.etag };
}

export async function completeUpload(env: Env, key: string, uploadId: string, parts: R2UploadedPart[]) {
  if (!key.startsWith("files/")) throw new Error("bad key");
  await env.BUCKET.resumeMultipartUpload(key, uploadId).complete(parts);
  return { key };
}

export async function bumpFile(env: Env, fileId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE jobs SET priority = -CAST(strftime('%s', 'now') AS INTEGER)
      WHERE status = 'queued' AND json_extract(payload, '$.file_id') = ?1`,
  )
    .bind(fileId)
    .run();
}

export async function retryFile(env: Env, fileId: string): Promise<boolean> {
  const file = await env.DB.prepare("SELECT mime FROM files WHERE id = ?1").bind(fileId).first<{ mime: string }>();
  if (!file) return false;
  const type = jobTypeFor(file.mime);
  if (!type) return false;
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM jobs WHERE json_extract(payload, '$.file_id') = ?1 AND status IN ('failed', 'queued')`,
    ).bind(fileId),
    env.DB.prepare(`UPDATE files SET text_status = 'pending', ${TOUCH} WHERE id = ?1`).bind(fileId),
    env.DB.prepare(
      `INSERT INTO jobs (type, payload, priority, run_after)
       VALUES (?1, json_object('file_id', ?2), -CAST(strftime('%s', 'now') AS INTEGER), ${NOW})`,
    ).bind(type, fileId),
  ]);
  return true;
}

// Queues every PDF reading to be checked and, where it helps, read again
// with the processor's current OCR. Each file is looked at on the laptop,
// which decides what to do with it: a scan is rebuilt from its pages with
// the full treatment, highlights or not, as the owner chose; good text is
// left alone. Files already waiting are left alone too, and the jobs go
// behind any other work.
export async function queueRescan(env: Env): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO jobs (type, payload, priority)
     SELECT 'extract_text',
            json_object('file_id', f.id, 'rescan', json('true'),
              'keep_pages', json('false')),
            NULL
       FROM files f
      WHERE f.deleted = 0 AND f.mime = 'application/pdf'
        AND EXISTS (SELECT 1 FROM items i WHERE i.file_id = f.id AND i.deleted = 0)
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.status IN ('queued', 'running')
                         AND json_extract(j.payload, '$.file_id') = f.id)`,
  ).run();
  return result.meta?.changes ?? 0;
}
