// Video readings get no picture from the processor, which never handles
// video, so the device takes one: a frame a tenth of the way in, past any
// black opening, drawn at 16:9 and stored as a picture, as a week's cover
// picture is. One video at a time, once per visit, from the copy on this
// device when there is one, and never over a connection that asks to save data.

import { update } from "./sync";
import type { FileRow } from "./types";
import { cachePicture, queuePictureUpload, sha256 } from "./uploads";

const WIDTH = 640;
const HEIGHT = 360;
const WAIT = 20_000;

// The moment to take the frame from: a tenth of the way in, at least a
// second in where the video is long enough, and never past the first minute.
export function videoFrameTime(duration: number | null | undefined): number {
  if (!duration || !Number.isFinite(duration) || duration <= 0) return 1;
  return Math.min(Math.max(duration * 0.1, Math.min(1, duration / 2)), 60);
}

const tried = new Set<string>();
let queue: Promise<void> = Promise.resolve();

export function requestVideoThumb(file: FileRow, local?: Blob | null): void {
  if (file.thumb_key || tried.has(file.id) || typeof document === "undefined") return;
  const saveData = (navigator as unknown as { connection?: { saveData?: boolean } }).connection?.saveData === true;
  if (!local && (!navigator.onLine || saveData || !file.r2_key)) return;
  tried.add(file.id);
  queue = queue.then(() => makeThumb(file, local ?? null)).catch(() => {
    // A video the browser cannot play keeps the plain tile with its play button.
  });
}

async function makeThumb(file: FileRow, local: Blob | null): Promise<void> {
  const src = local ? URL.createObjectURL(local) : `/api/objects/${file.r2_key}`;
  try {
    const blob = await captureFrame(src);
    const sha = await sha256(blob);
    const key = `pictures/${sha}.${blob.type === "image/webp" ? "webp" : "jpg"}`;
    await cachePicture(key, blob);
    await queuePictureUpload(key, blob, sha);
    await update("files", file.id, { thumb_key: key });
  } finally {
    if (local) URL.revokeObjectURL(src);
  }
}

function waitFor(target: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("The video took too long to load.")), WAIT);
    const done = () => finish();
    const failed = () => finish(new Error("The video could not be read."));
    function finish(error?: Error) {
      clearTimeout(timer);
      target.removeEventListener(event, done);
      target.removeEventListener("error", failed);
      if (error) reject(error);
      else resolve();
    }
    target.addEventListener(event, done, { once: true });
    target.addEventListener("error", failed, { once: true });
  });
}

function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  const attempt = (type: string, quality: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  return attempt("image/webp", 0.8).then(async (webp) => {
    if (webp && webp.type === "image/webp") return webp;
    const jpeg = await attempt("image/jpeg", 0.85);
    if (!jpeg) throw new Error("The frame could not be saved.");
    return jpeg;
  });
}

async function captureFrame(src: string): Promise<Blob> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = src;
  try {
    await waitFor(video, "loadedmetadata");
    video.currentTime = videoFrameTime(video.duration);
    await waitFor(video, "seeked");
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) throw new Error("The video has no picture.");
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable.");
    // Fill the 16:9 frame, cropping the edges of a video of another shape.
    const scale = Math.max(WIDTH / vw, HEIGHT / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    ctx.drawImage(video, (WIDTH - dw) / 2, (HEIGHT - dh) / 2, dw, dh);
    return await encode(canvas);
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}
