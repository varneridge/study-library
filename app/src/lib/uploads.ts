// The upload queue. Blobs wait in IndexedDB, so a reload or a closed laptop
// only restarts the file that was uploading, not the whole batch.

import { db, type PendingUpload } from "./db";
import { api, commit, newId } from "./sync";

const CONCURRENCY = 3;
// Files above this size go up in parts, each well under the Worker's limit.
const PART_BYTES = 50 * 1024 * 1024;
const progress = new Map<string, number>();
const listeners = new Set<() => void>();
let running = 0;

export const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  webm: "audio/webm",
  aac: "audio/aac",
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  doc: "application/msword",
  epub: "application/epub+zip",
};

export function mimeFor(file: Pick<File, "name" | "type">): string | null {
  const rawType = (file.type || "").split(";")[0].trim().toLowerCase();
  if (rawType === "video/x-m4v" || rawType === "video/mp4") return "video/mp4";
  if (rawType === "video/webm") return "video/webm";
  if (rawType === "video/quicktime") return "video/quicktime";
  if (rawType === "audio/x-m4a" || rawType === "audio/mp4") return "audio/mp4";
  if (rawType === "audio/webm") return "audio/webm";
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? null;
}

export async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function uploadProgress(id: string): number | undefined {
  return progress.get(id);
}

export function onUploadProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  listeners.forEach((listener) => listener());
}

export async function queueUpload(input: Omit<PendingUpload, "id" | "status" | "attempts" | "error" | "created_at">) {
  await db.uploads.put({
    ...input, id: newId(), status: "queued", attempts: 0, error: null, created_at: new Date().toISOString(),
  });
  void pump();
}

const activeUploadXhrs = new Map<string, XMLHttpRequest>();
const cancelledUploadIds = new Set<string>();

// If undone while a complete request was in flight, the first finish commit
// and the restored upload commit the same file row safely.
export function uncancelUpload(uploadId: string): void {
  cancelledUploadIds.delete(uploadId);
}

function abortUpload(uploadId: string): void {
  cancelledUploadIds.add(uploadId);
  const xhr = activeUploadXhrs.get(uploadId);
  if (xhr) {
    try { xhr.abort(); } catch {}
    activeUploadXhrs.delete(uploadId);
  }
}

export async function cancelUploadsForItem(itemId: string): Promise<PendingUpload[]> {
  const pending = await db.uploads.where("item_id").equals(itemId).toArray();
  for (const u of pending) {
    abortUpload(u.id);
  }
  await db.uploads.where("item_id").equals(itemId).delete();
  return pending;
}

export async function cancelAllUploads(): Promise<void> {
  const all = await db.uploads.toArray();
  for (const u of all) {
    abortUpload(u.id);
  }
  await db.uploads.clear();
}

// XMLHttpRequest reports upload progress, which fetch does not.
function put(url: string, body: Blob, mime: string | null, onProgress: (fraction: number) => void, uploadId?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (uploadId && cancelledUploadIds.has(uploadId)) {
      reject(new Error("upload cancelled"));
      return;
    }
    const xhr = new XMLHttpRequest();
    if (uploadId) activeUploadXhrs.set(uploadId, xhr);
    xhr.open("PUT", url);
    if (mime) xhr.setRequestHeader("content-type", mime);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (uploadId) activeUploadXhrs.delete(uploadId);
      if (xhr.status >= 200 && xhr.status < 300 && !xhr.responseURL.includes("cloudflareaccess.com")) resolve(xhr.responseText);
      else reject(new Error(`upload returned ${xhr.status}`));
    };
    xhr.onerror = () => {
      if (uploadId) activeUploadXhrs.delete(uploadId);
      reject(new Error("network error"));
    };
    xhr.onabort = () => {
      if (uploadId) activeUploadXhrs.delete(uploadId);
      reject(new Error("upload cancelled"));
    };
    xhr.send(body);
  });
}

async function send(upload: PendingUpload): Promise<string> {
  if (cancelledUploadIds.has(upload.id)) throw new Error("upload cancelled");
  const report = (fraction: number) => {
    progress.set(upload.id, fraction);
    notify();
  };
  if (upload.kind === "picture") {
    const filename = upload.name.replace(/^pictures\//, "");
    return JSON.parse(await put(`/api/pictures/${filename}`, upload.blob, upload.mime, report, upload.id)).key;
  }
  if (upload.bytes <= PART_BYTES) {
    return JSON.parse(await put(`/api/files/${upload.sha256}`, upload.blob, upload.mime, report, upload.id)).key;
  }

  let state = upload.multipart;
  if (!state) {
    if (cancelledUploadIds.has(upload.id)) throw new Error("upload cancelled");
    const started = await (await api("/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha256: upload.sha256, mime: upload.mime }),
    })).json();
    if (started.existed) return started.key;
    state = { key: started.key, upload_id: started.upload_id, parts: [] };
    if (cancelledUploadIds.has(upload.id)) throw new Error("upload cancelled");
    await db.uploads.update(upload.id, { multipart: state });
  }
  const total = Math.ceil(upload.bytes / PART_BYTES);
  for (let number = 1; number <= total; number += 1) {
    if (cancelledUploadIds.has(upload.id)) throw new Error("upload cancelled");
    if (state.parts.some((p) => p.part_number === number)) continue;
    const body = upload.blob.slice((number - 1) * PART_BYTES, Math.min(number * PART_BYTES, upload.bytes));
    const url = `/api/uploads/${encodeURIComponent(state.upload_id)}/${number}?key=${encodeURIComponent(state.key)}`;
    const part = JSON.parse(await put(url, body, null, (f) => report((number - 1 + f) / total), upload.id));
    if (cancelledUploadIds.has(upload.id)) throw new Error("upload cancelled");
    state = { ...state, parts: [...state.parts, part] };
    await db.uploads.update(upload.id, { multipart: state });
  }
  if (cancelledUploadIds.has(upload.id)) throw new Error("upload cancelled");
  const done = await (await api(`/api/uploads/${encodeURIComponent(state.upload_id)}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: state.key, parts: [...state.parts].sort((a, b) => a.part_number - b.part_number) }),
  })).json();
  return done.key;
}

async function finish(upload: PendingUpload, key: string) {
  if (cancelledUploadIds.has(upload.id)) return;
  await db.transaction("rw", [db.uploads, db.files, db.items, db.recordings, db.outbox], async () => {
    // If the upload was cancelled or undone while in flight, do not commit.
    if (cancelledUploadIds.has(upload.id)) return;
    const current = await db.uploads.get(upload.id);
    if (!current) return;
    if (upload.kind === "picture") {
      await db.uploads.delete(upload.id);
      return;
    }
    const file = {
      table: "files" as const,
      row: {
        id: upload.file_id, sha256: upload.sha256, r2_key: key, mime: upload.mime, bytes: upload.bytes,
        original_name: upload.name, page_count: null,
        text_status: upload.recording_id || upload.mime.startsWith("video/") ? ("ready" as const) : ("pending" as const),
      },
    };
    // The file row goes first, so nothing ever points at a missing file.
    if (upload.recording_id) {
      const recording = await db.recordings.get(upload.recording_id);
      await commit([
        file,
        ...(recording && !recording.deleted
          ? [{ table: "recordings" as const, row: { ...recording, file_id: upload.file_id, status: "uploaded" } }]
          : []),
      ]);
    } else {
      const item = await db.items.get(upload.item_id);
      await commit([file, ...(item && !item.deleted ? [{ table: "items" as const, row: { ...item, file_id: upload.file_id } }] : [])]);
    }
    await db.uploads.delete(upload.id);
  });
}

export async function pump(): Promise<void> {
  if (!navigator.onLine) return;
  while (running < CONCURRENCY) {
    const next = await db.transaction("rw", db.uploads, async () => {
      const queued = await db.uploads.where("status").equals("queued").first();
      if (!queued) return null;
      await db.uploads.update(queued.id, { status: "uploading" });
      return queued;
    });
    if (!next) return;
    running += 1;
    void (async () => {
      try {
        const key = await send(next);
        await finish(next, key);
      } catch (error) {
        cancelledUploadIds.delete(next.id);
        const attempts = next.attempts + 1;
        await db.uploads.update(next.id, {
          status: attempts >= 5 ? "failed" : "queued",
          attempts,
          error: error instanceof Error ? error.message : String(error),
        });
        if (attempts < 5) setTimeout(() => void pump(), 5000 * attempts);
      } finally {
        progress.delete(next.id);
        running -= 1;
        notify();
        void pump();
      }
    })();
  }
}

// Uploads marked as uploading when the page closed go back in the queue.
export async function resumeUploads(): Promise<void> {
  await db.uploads.where("status").equals("uploading").modify({ status: "queued" });
  void pump();
}

export async function retryUpload(id: string): Promise<void> {
  await db.uploads.update(id, { status: "queued", attempts: 0, error: null });
  void pump();
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const IMAGE_LIMIT = 20 * 1024 * 1024;

// Puts a picture for a note into storage and returns its address. Files are
// stored by their contents, so the same picture is only kept once.
export async function uploadImage(file: File): Promise<string> {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error("Use a PNG, JPEG, GIF or WebP picture.");
  if (file.size > IMAGE_LIMIT) throw new Error("That picture is over 20 MB.");
  if (!navigator.onLine) throw new Error("Connect to the internet to add a picture.");
  const sha = await sha256(file);
  const response = await api(`/api/files/${sha}`, { method: "PUT", headers: { "content-type": file.type }, body: file });
  const { key } = (await response.json()) as { key: string };
  return `/api/objects/${key}`;
}

function loadImg(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Image decode failed"));
    };
    img.src = url;
  });
}

// Resizes and centre-crops a module picture to 16:9 (960x540) on canvas,
// preserving orientation and encoding as WebP with JPEG fallback.
export async function resizeModulePicture(file: File): Promise<{ blob: Blob; ext: "webp" | "jpg"; sha: string; key: string }> {
  let source: ImageBitmap | HTMLImageElement;
  try {
    if (typeof createImageBitmap === "function") {
      source = await createImageBitmap(file, { imageOrientation: "from-image" });
    } else {
      source = await loadImg(file);
    }
  } catch {
    try {
      source = await loadImg(file);
    } catch {
      throw new Error("Could not read this picture. Try another image.");
    }
  }

  const sw = source.width;
  const sh = source.height;
  if (!sw || !sh) {
    if ("close" in source && typeof source.close === "function") source.close();
    throw new Error("Could not read image dimensions.");
  }

  const targetW = 960;
  const targetH = 540;
  const targetAspect = 16 / 9;
  const sourceAspect = sw / sh;

  let cropW = sw;
  let cropH = sh;
  let cropX = 0;
  let cropY = 0;

  if (sourceAspect > targetAspect) {
    cropW = Math.round(sh * targetAspect);
    cropX = Math.round((sw - cropW) / 2);
  } else {
    cropH = Math.round(sw / targetAspect);
    cropY = Math.round((sh - cropH) / 2);
  }

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    if ("close" in source && typeof source.close === "function") source.close();
    throw new Error("Canvas context unavailable.");
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, cropX, cropY, cropW, cropH, 0, 0, targetW, targetH);

  if ("close" in source && typeof source.close === "function") source.close();

  const toBlob = (c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> =>
    new Promise((resolve, reject) => {
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("Encoding failed"))), type, quality);
    });

  let blob: Blob;
  let ext: "webp" | "jpg" = "webp";
  try {
    blob = await toBlob(canvas, "image/webp", 0.82);
    if (blob.type !== "image/webp") {
      blob = await toBlob(canvas, "image/jpeg", 0.85);
      ext = "jpg";
    }
  } catch {
    blob = await toBlob(canvas, "image/jpeg", 0.85);
    ext = "jpg";
  }

  const sha = await sha256(blob);
  const key = `pictures/${sha}.${ext}`;
  return { blob, ext, sha, key };
}

export async function cachePicture(key: string, blob: Blob): Promise<void> {
  if (typeof window !== "undefined" && "caches" in window) {
    try {
      const filename = key.replace(/^pictures\//, "");
      const cache = await caches.open("study-pictures-v1");
      const makeResponse = () =>
        new Response(blob, {
          headers: {
            "content-type": blob.type,
            "content-length": String(blob.size),
            "cache-control": "private, max-age=31536000, immutable",
          },
        });
      await cache.put(`/api/pictures/${filename}`, makeResponse());
      await cache.put(`/api/objects/${key}`, makeResponse());
    } catch {
      // ignore cache failure
    }
  }
}

export async function queuePictureUpload(key: string, blob: Blob, sha: string): Promise<void> {
  await db.uploads.put({
    id: newId(),
    kind: "picture",
    file_id: "",
    item_id: "",
    name: key,
    mime: blob.type,
    sha256: sha,
    bytes: blob.size,
    blob,
    status: "queued",
    attempts: 0,
    error: null,
    created_at: new Date().toISOString(),
  });
  void pump();
}

export async function uploadModulePicture(file: File): Promise<string> {
  const { blob, sha, key } = await resizeModulePicture(file);
  await cachePicture(key, blob);
  await queuePictureUpload(key, blob, sha);
  return key;
}
