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
};

export function mimeFor(file: File): string | null {
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

// XMLHttpRequest reports upload progress, which fetch does not.
function put(url: string, body: Blob, mime: string | null, onProgress: (fraction: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    if (mime) xhr.setRequestHeader("content-type", mime);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && !xhr.responseURL.includes("cloudflareaccess.com")) resolve(xhr.responseText);
      else reject(new Error(`upload returned ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.send(body);
  });
}

async function send(upload: PendingUpload): Promise<string> {
  const report = (fraction: number) => {
    progress.set(upload.id, fraction);
    notify();
  };
  if (upload.bytes <= PART_BYTES) {
    return JSON.parse(await put(`/api/files/${upload.sha256}`, upload.blob, upload.mime, report)).key;
  }

  let state = upload.multipart;
  if (!state) {
    const started = await (await api("/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha256: upload.sha256, mime: upload.mime }),
    })).json();
    if (started.existed) return started.key;
    state = { key: started.key, upload_id: started.upload_id, parts: [] };
    await db.uploads.update(upload.id, { multipart: state });
  }
  const total = Math.ceil(upload.bytes / PART_BYTES);
  for (let number = 1; number <= total; number += 1) {
    if (state.parts.some((p) => p.part_number === number)) continue;
    const body = upload.blob.slice((number - 1) * PART_BYTES, Math.min(number * PART_BYTES, upload.bytes));
    const url = `/api/uploads/${encodeURIComponent(state.upload_id)}/${number}?key=${encodeURIComponent(state.key)}`;
    const part = JSON.parse(await put(url, body, null, (f) => report((number - 1 + f) / total)));
    state = { ...state, parts: [...state.parts, part] };
    await db.uploads.update(upload.id, { multipart: state });
  }
  const done = await (await api(`/api/uploads/${encodeURIComponent(state.upload_id)}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: state.key, parts: [...state.parts].sort((a, b) => a.part_number - b.part_number) }),
  })).json();
  return done.key;
}

async function finish(upload: PendingUpload, key: string) {
  const file = {
    table: "files" as const,
    row: {
      id: upload.file_id, sha256: upload.sha256, r2_key: key, mime: upload.mime, bytes: upload.bytes,
      original_name: upload.name, page_count: null,
      text_status: upload.recording_id ? ("ready" as const) : ("pending" as const),
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
}

export async function pump(): Promise<void> {
  if (!navigator.onLine) return;
  while (running < CONCURRENCY) {
    const next = await db.uploads.where("status").equals("queued").first();
    if (!next) return;
    await db.uploads.update(next.id, { status: "uploading" });
    running += 1;
    void (async () => {
      try {
        const key = await send(next);
        await finish(next, key);
      } catch (error) {
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
