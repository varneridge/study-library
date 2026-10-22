// Live recording. Audio is captured in short chunks, each saved to IndexedDB
// before upload, so a crash or a dropped connection loses seconds at most.

import { useEffect, useState } from "react";
import { db } from "./db";
import { api, insert, newId, update } from "./sync";
import { showToast } from "./ui";

const CHUNK_MS = 20_000;
// This long with no sound at all means the microphone is probably not
// hearing the room: muted, unplugged, or the wrong input chosen.
const SILENT_MS = 30_000;
// Below this level the input is digital silence, not a quiet room.
const SILENT_LEVEL = 0.02;
const OWNED_KEY = "owned-recordings";
// A tab that is still recording updates its timestamp every second. Another tab
// in the same browser leaves the recording alone while that timestamp is fresh.
const LIVE_HEARTBEAT_MS = 15_000;

interface OwnedRecording {
  chunks: number;
  seenAt: number;
}

function readOwned(): Record<string, OwnedRecording> {
  try {
    const raw = localStorage.getItem(OWNED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, OwnedRecording>;
  } catch {
    return {};
  }
}

function writeOwned(owned: Record<string, OwnedRecording>): void {
  try {
    localStorage.setItem(OWNED_KEY, JSON.stringify(owned));
  } catch {
    // Storage unavailable; in-memory active state still works.
  }
}

function noteOwned(recordingId: string, chunks: number, seenAt = Date.now()): void {
  const owned = readOwned();
  const prev = owned[recordingId];
  owned[recordingId] = {
    chunks: Math.max(prev?.chunks ?? 0, chunks),
    seenAt,
  };
  writeOwned(owned);
}

function forgetOwned(recordingId: string): void {
  const owned = readOwned();
  if (!(recordingId in owned)) return;
  delete owned[recordingId];
  writeOwned(owned);
}

export type MicProblem = "silent" | null;

interface Active {
  recordingId: string;
  sessionId: string;
  startedAt: number;
  recorder: MediaRecorder;
  stream: MediaStream;
  index: number;
  wakeLock: WakeLockSentinel | null;
  // Time spent paused is left out of the recording's length.
  pausedAt: number | null;
  pausedFor: number;
  analyser: AnalyserNode | null;
  audio: AudioContext | null;
  // When the input last went silent, and whether that has lasted too long.
  quietSince: number | null;
  problem: MicProblem;
  watch: ReturnType<typeof setInterval> | null;
  stopping: boolean;
}

let active: Active | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function pickMime(): string {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return options.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

function elapsedOf(a: Active): number {
  const now = a.pausedAt ?? Date.now();
  return Math.max(0, (now - a.startedAt - a.pausedFor) / 1000);
}

export function activeSession(): string | null {
  return active?.sessionId ?? null;
}

export async function startRecording(sessionId: string): Promise<void> {
  if (active) throw new Error("A recording is already running.");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const mime = pickMime();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48_000 } : undefined);
  const recordingId = newId();
  noteOwned(recordingId, 0);
  await insert("recordings", {
    id: recordingId, session_id: sessionId, source: "live", file_id: null, duration_seconds: null,
    status: "recording",
  });

  let wakeLock: WakeLockSentinel | null = null;
  try {
    wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
  } catch {
    wakeLock = null;
  }

  // A level meter, so you can see the microphone is hearing the room.
  let audio: AudioContext | null = null;
  let analyser: AudioNode | null = null;
  try {
    audio = new AudioContext();
    const node = audio.createAnalyser();
    node.fftSize = 512;
    audio.createMediaStreamSource(stream).connect(node);
    void audio.resume().catch(() => undefined);
    analyser = node;
  } catch {
    audio = null;
  }

  active = {
    recordingId, sessionId, startedAt: Date.now(), recorder, stream, index: 0, wakeLock,
    pausedAt: null, pausedFor: 0, analyser: analyser as AnalyserNode | null, audio,
    quietSince: null, problem: null, watch: null, stopping: false,
  };
  const current = active;
  current.watch = setInterval(() => watchLevel(current), 1000);
  // A microphone that goes away (unplugged, a headset out of charge, access
  // withdrawn) ends the recording. What was captured is kept and uploaded.
  for (const track of stream.getAudioTracks()) {
    track.addEventListener("ended", () => void microphoneLost(current));
  }
  recorder.addEventListener("error", () => void microphoneLost(current));
  window.addEventListener("beforeunload", guard);
  window.addEventListener("pagehide", onUnload);
  document.addEventListener("visibilitychange", relock);
  recorder.ondataavailable = (event) => {
    if (!event.data.size || !active) return;
    const chunkMime = (recorder.mimeType || "audio/webm").split(";")[0];
    const index = active.index++;
    noteOwned(recordingId, index + 1);
    void db.chunks.add({ recording_id: recordingId, index, mime: chunkMime, blob: event.data }).then(() => pumpChunks());
  };
  recorder.start(CHUNK_MS);
  notify();
}

// Notices a silent input while recording, and clears the notice once sound returns.
function watchLevel(current: Active): void {
  if (active !== current) return;
  noteOwned(current.recordingId, current.index);
  if (current.pausedAt !== null || !current.analyser) {
    current.quietSince = null;
    return;
  }
  const now = Date.now();
  if (inputLevel() >= SILENT_LEVEL) {
    current.quietSince = null;
    if (current.problem) { current.problem = null; notify(); }
    return;
  }
  current.quietSince ??= now;
  if (!current.problem && now - current.quietSince >= SILENT_MS) {
    current.problem = "silent";
    notify();
  }
}

async function microphoneLost(current: Active): Promise<void> {
  if (active !== current || current.stopping) return;
  const at = clock(elapsedOf(current));
  const sessionId = current.sessionId;
  await stopRecording();
  showToast(`The microphone stopped, so the recording ended at ${at}. What was recorded is saved.`, {
    label: "Record again",
    run: () => void startRecording(sessionId).catch(() => showToast("The microphone is still not available.")),
  }, 20_000);
}

export async function stopRecording(): Promise<void> {
  if (!active || active.stopping) return;
  const current = active;
  current.stopping = true;
  if (current.watch) clearInterval(current.watch);
  if (current.recorder.state !== "inactive") {
    const stopped = new Promise<void>((resolve) => current.recorder.addEventListener("stop", () => resolve(), { once: true }));
    current.recorder.stop();
    await stopped;
  }
  current.stream.getTracks().forEach((t) => t.stop());
  void current.wakeLock?.release().catch(() => undefined);
  void current.audio?.close().catch(() => undefined);
  window.removeEventListener("beforeunload", guard);
  window.removeEventListener("pagehide", onUnload);
  document.removeEventListener("visibilitychange", relock);
  const duration = Math.round(elapsedOf(current) * 10) / 10;
  active = null;
  await update("recordings", current.recordingId, { status: "uploading", duration_seconds: duration });
  notify();
  void pumpChunks();
}

// Closing or reloading the tab would end the recording, so the browser asks first.
function guard(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = "";
}

function onUnload() {
  if (!active) return;
  noteOwned(active.recordingId, active.index, 0);
}

// The screen lock is let go when the tab is hidden; it is taken again on return.
function relock() {
  if (document.visibilityState !== "visible" || !active) return;
  const current = active;
  void navigator.wakeLock?.request("screen").then((lock) => { current.wakeLock = lock; }).catch(() => undefined);
}

export function pauseRecording(): void {
  if (!active || active.pausedAt !== null || active.recorder.state !== "recording") return;
  active.recorder.pause();
  active.pausedAt = Date.now();
  notify();
}

export function resumeRecording(): void {
  if (!active || active.pausedAt === null) return;
  active.recorder.resume();
  active.pausedFor += Date.now() - active.pausedAt;
  active.pausedAt = null;
  notify();
}

// How loud the room is now, from 0 to 1.
export function inputLevel(): number {
  const analyser = active?.analyser;
  if (!analyser || active?.pausedAt !== null) return 0;
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
  return Math.min(1, peak / 64);
}

export interface RecordingNow { recordingId: string; sessionId: string; elapsed: number; paused: boolean; problem: MicProblem }

// The recording in progress, from any screen.
export function useRecordingNow(): RecordingNow | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((n) => n + 1);
    listeners.add(listener);
    const timer = setInterval(listener, 1000);
    return () => { listeners.delete(listener); clearInterval(timer); };
  }, []);
  if (!active) return null;
  return {
    recordingId: active.recordingId, sessionId: active.sessionId, elapsed: elapsedOf(active),
    paused: active.pausedAt !== null, problem: active.problem,
  };
}

let pumping = false;

// Uploads waiting chunks in order. A recording becomes "uploaded" once it has
// stopped and all of its chunks are on the server, which starts processing.
export async function pumpChunks(): Promise<void> {
  if (pumping || !navigator.onLine) return;
  pumping = true;
  try {
    for (;;) {
      const chunk = await db.chunks.orderBy("id").first();
      if (!chunk) break;
      await api(`/api/recordings/${chunk.recording_id}/chunks/${chunk.index}`, {
        method: "PUT",
        headers: { "content-type": chunk.mime },
        body: chunk.blob,
      });
      await db.chunks.delete(chunk.id!);
    }
    const owned = readOwned();
    const waiting = (await db.recordings.toArray()).filter(
      (r) => !r.deleted && r.status === "uploading" && r.source === "live" && r.id in owned,
    );
    for (const recording of waiting) {
      if ((await db.chunks.where("recording_id").equals(recording.id).count()) === 0) {
        await update("recordings", recording.id, { status: "uploaded" });
        forgetOwned(recording.id);
      }
    }
  } catch {
    setTimeout(() => void pumpChunks(), 10_000);
  } finally {
    pumping = false;
  }
}

// A recording left running on this device when its tab closed is treated as stopped.
// Recordings started on another device, or still live in another tab, are left alone.
export async function recoverRecordings(): Promise<void> {
  const owned = readOwned();
  const now = Date.now();
  const stale = (await db.recordings.toArray()).filter(
    (r) => !r.deleted && r.status === "recording" && r.source === "live" && r.id in owned,
  );
  for (const recording of stale) {
    if (active?.recordingId === recording.id) continue;
    const entry = owned[recording.id];
    if (entry && entry.seenAt > 0 && now - entry.seenAt < LIVE_HEARTBEAT_MS) continue;
    const localChunks = await db.chunks.where("recording_id").equals(recording.id).count();
    if ((entry?.chunks ?? 0) === 0 && localChunks === 0) {
      await update("recordings", recording.id, { deleted: true });
      forgetOwned(recording.id);
    } else {
      await update("recordings", recording.id, { status: "uploading" });
    }
  }
  void pumpChunks();
}

// Finishes a recording left behind on a device that never comes back.
export async function finishRecording(recordingId: string): Promise<void> {
  if (active?.recordingId === recordingId) {
    await stopRecording();
    return;
  }
  await pumpChunks();
  await update("recordings", recordingId, { status: "uploaded" });
  forgetOwned(recordingId);
}

export function useRecorder(sessionId: string) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((n) => n + 1);
    listeners.add(listener);
    const timer = setInterval(listener, 1000);
    return () => {
      listeners.delete(listener);
      clearInterval(timer);
    };
  }, []);
  const mine = active?.sessionId === sessionId;
  return {
    recording: mine,
    elsewhere: Boolean(active) && !mine,
    elapsed: mine && active ? elapsedOf(active) : 0,
    paused: mine && active ? active.pausedAt !== null : false,
    recordingId: mine ? active!.recordingId : null,
    problem: mine && active ? active.problem : null,
  };
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}
