// Downloading and caching file contents for reading offline.

import { db, getMeta, setMeta } from "./db";
import { api } from "./sync";
import type { FileRow } from "./types";

const inflight = new Map<string, Promise<Blob>>();

export async function fileBlob(file: FileRow): Promise<Blob> {
  const cached = await db.blobs.get(file.id);
  if (cached && cached.r2_key === file.r2_key) return cached.blob;

  const pending = inflight.get(file.id);
  if (pending) return pending;

  const request = (async () => {
    const response = await api(`/api/objects/${file.r2_key}`);
    const blob = await response.blob();
    await db.blobs.put({
      file_id: file.id, r2_key: file.r2_key, blob, bytes: blob.size, cached_at: new Date().toISOString(),
    });
    return blob;
  })();
  inflight.set(file.id, request);
  try {
    return await request;
  } finally {
    inflight.delete(file.id);
  }
}

export async function isCached(file: FileRow): Promise<boolean> {
  const cached = await db.blobs.get(file.id);
  return Boolean(cached && cached.r2_key === file.r2_key);
}

// Fetch files in the background, a few at a time, skipping what is cached.
export async function prefetch(files: FileRow[]): Promise<void> {
  if (!navigator.onLine) return;
  const queue = files.filter((f) => f.mime === "application/pdf");
  const workers = Array.from({ length: 3 }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      if (!(await isCached(file))) await fileBlob(file).catch(() => undefined);
    }
  });
  await Promise.all(workers);
}

export async function keepEverything(): Promise<boolean> {
  return (await getMeta<boolean>("keep_everything")) ?? false;
}

export async function setKeepEverything(value: boolean): Promise<void> {
  await setMeta("keep_everything", value);
  if (value) {
    if (navigator.storage?.persist) await navigator.storage.persist();
    const files = (await db.files.toArray()).filter((f) => !f.deleted);
    void prefetch(files);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
