/// <reference lib="webworker" />
// Kokoro-82M in the browser, off the main thread. Loaded by browserEngine.ts as
// a module worker (Vite: new URL("./kokoro.worker.ts", import.meta.url)).
//
// kokoro-js 1.2.1 phonemises text and runs the ONNX model, but its
// generate_from_ids keeps only the waveform output, so no word timing reaches
// the caller even from a model that predicts durations. This worker replaces
// generate_from_ids on the instance with the same model call (same style slice,
// same inputs) that also keeps `durations` when the graph outputs them, and
// turns them into word spans with durations.ts. Without them, the utterance
// gets no tokens and align.ts interpolates by word length instead.
//
// Model weights are cached by transformers.js in Cache Storage; voices are
// cached here under "kokoro-voices", the cache and keys kokoro-js itself uses,
// so either code path finds a voice the other fetched.

import type { KokoroTTS, KokoroVoice } from "kokoro-js";
import type { RawAudio, Tensor } from "@huggingface/transformers";
import { joinChunkSpans, spansFromDurations } from "./durations";
import type { TimedToken, VoiceInfo } from "./types";
import type { KokoroDevice, KokoroDtype, LoadOptions, WorkerRequest, WorkerResponse } from "./workerProtocol";

declare const self: DedicatedWorkerGlobalScope;

const SAMPLE_RATE = 24_000;
const STYLE_DIM = 256;
// kokoro-js truncates input to 510 tokens and picks the style row by length (dist/kokoro.js, generate_from_ids).
const MAX_STYLE_ROW = 509;

interface Job {
  id: number;
  text: string;
  voice: string;
}

let KokoroTTSClass: typeof KokoroTTS | null = null;
let RawAudioClass: typeof RawAudio | null = null;
let TensorClass: typeof Tensor | null = null;

async function ensureModules(): Promise<void> {
  if (KokoroTTSClass && RawAudioClass && TensorClass) return;
  const kokoroCdn = "https://esm.sh/kokoro-js@1.2.1";
  const hfCdn = "https://esm.sh/@huggingface/transformers@3.3.3";
  try {
    const k = (await import(/* @vite-ignore */ kokoroCdn)) as { KokoroTTS: typeof KokoroTTS };
    const h = (await import(/* @vite-ignore */ hfCdn)) as { RawAudio: typeof RawAudio; Tensor: typeof Tensor };
    KokoroTTSClass = k.KokoroTTS;
    RawAudioClass = h.RawAudio;
    TensorClass = h.Tensor;
  } catch {
    const kokoroPkg = "kokoro-js";
    const hfPkg = "@huggingface/transformers";
    const k = (await import(/* @vite-ignore */ kokoroPkg)) as { KokoroTTS: typeof KokoroTTS };
    const h = (await import(/* @vite-ignore */ hfPkg)) as { RawAudio: typeof RawAudio; Tensor: typeof Tensor };
    KokoroTTSClass = k.KokoroTTS;
    RawAudioClass = h.RawAudio;
    TensorClass = h.Tensor;
  }
}

let tts: KokoroTTS | null = null;
let voiceBase = "";
let lastDurations: Float64Array | null = null;
const voiceCache = new Map<string, Float32Array>();
const queue: Job[] = [];
const cancelled = new Set<number>();
let busy = false;

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function voiceData(voice: string): Promise<Float32Array> {
  const hit = voiceCache.get(voice);
  if (hit) return hit;
  const url = `${voiceBase}/${voice}.bin`;
  let cache: Cache | null = null;
  try {
    cache = await caches.open("kokoro-voices");
    const stored = await cache.match(url);
    if (stored) {
      const data = new Float32Array(await stored.arrayBuffer());
      voiceCache.set(voice, data);
      return data;
    }
  } catch {
    cache = null; // private browsing can refuse Cache Storage; fetch every time instead
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`voice ${voice} could not be fetched (HTTP ${res.status})`);
  const buf = await res.arrayBuffer();
  if (cache) {
    try {
      await cache.put(url, new Response(buf.slice(0), { headers: { "Content-Type": "application/octet-stream" } }));
    } catch {
      // A full cache only costs a refetch next time.
    }
  }
  const data = new Float32Array(buf);
  voiceCache.set(voice, data);
  return data;
}

async function pickDevice(requested?: KokoroDevice): Promise<KokoroDevice> {
  if (requested) return requested;
  const gpu = (self.navigator as WorkerNavigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  try {
    if (gpu && (await gpu.requestAdapter())) return "webgpu";
  } catch {
    // No usable adapter.
  }
  return "wasm";
}

function install(model: KokoroTTS): void {
  const graph = model.model as unknown as (inputs: Record<string, Tensor>) => Promise<{ waveform: Tensor; durations?: Tensor }>;
  (model as unknown as { generate_from_ids: unknown }).generate_from_ids = async (
    ids: Tensor,
    { voice = "af_heart", speed = 1 }: { voice?: string; speed?: number } = {},
  ): Promise<RawAudio> => {
    const row = Math.min(Math.max(Number(ids.dims[ids.dims.length - 1]) - 2, 0), MAX_STYLE_ROW);
    const data = await voiceData(voice);
    const style = data.slice(STYLE_DIM * row, STYLE_DIM * row + STYLE_DIM);
    const out = await graph({
      input_ids: ids,
      style: new TensorClass!("float32", style, [1, STYLE_DIM]),
      speed: new TensorClass!("float32", [speed], [1]),
    });
    // Durations come as int64 (BigInt64Array) from most exports, so convert element by element.
    lastDurations = out.durations ? Float64Array.from(out.durations.data as ArrayLike<number | bigint>, (x) => Number(x)) : null;
    return new RawAudioClass!(out.waveform.data as Float32Array, SAMPLE_RATE);
  };
}

function voiceList(model: KokoroTTS): VoiceInfo[] {
  const list = Object.entries(model.voices).map(([id, val]) => {
    const v = val as KokoroVoice;
    return {
      id,
      name: v.name,
      lang: v.language === "en-gb" ? ("en-GB" as const) : ("en-US" as const),
      gender: v.gender === "Male" ? ("Male" as const) : ("Female" as const),
      grade: v.overallGrade,
    };
  });
  // British voices first: Study Library reads British English.
  return list.sort((a, b) => Number(b.lang === "en-GB") - Number(a.lang === "en-GB"));
}

async function load(options: LoadOptions): Promise<void> {
  await ensureModules();
  if (!KokoroTTSClass || !TensorClass || !RawAudioClass) {
    post({ type: "load-failed", message: "Failed to load KokoroTTS modules" });
    return;
  }
  voiceBase = options.voiceBase.replace(/\/+$/, "");
  const device = await pickDevice(options.device);
  const dtype: KokoroDtype = options.dtype ?? (device === "webgpu" ? "fp32" : "q8");
  let last = "no model id was given";
  for (const modelId of options.modelIds) {
    try {
      const model = await KokoroTTSClass.from_pretrained(modelId, {
        dtype,
        device,
        progress_callback: (p: unknown) => {
          const r = p as { status?: string; file?: string; loaded?: number; total?: number };
          if (r.status === "progress") post({ type: "progress", file: String(r.file ?? ""), loaded: Number(r.loaded) || 0, total: Number(r.total) || 0 });
        },
      });
      install(model);
      tts = model;
      post({ type: "loaded", modelId, device, dtype, voices: voiceList(model) });
      return;
    } catch (e) {
      last = `${modelId}: ${messageOf(e)}`;
    }
  }
  post({ type: "load-failed", message: last });
}

async function run(job: Job): Promise<void> {
  if (!tts) throw new Error("the model is not loaded");
  const pcmChunks: Float32Array[] = [];
  const spanChunks: Array<{ spans: TimedToken[]; seconds: number }> = [];
  let timestamped = true;
  // stream() splits long text into sentences itself and phonemises each one.
  for await (const part of tts.stream(job.text, { voice: job.voice as never, speed: 1 })) {
    if (cancelled.has(job.id)) throw new Error("cancelled");
    const pcm = part.audio.audio as Float32Array;
    const seconds = pcm.length / SAMPLE_RATE;
    const spans = lastDurations ? spansFromDurations(part.phonemes, lastDurations, seconds) : [];
    lastDurations = null;
    if (spans.length === 0) timestamped = false;
    pcmChunks.push(pcm);
    spanChunks.push({ spans, seconds });
  }
  const pcm = new Float32Array(pcmChunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of pcmChunks) {
    pcm.set(c, o);
    o += c.length;
  }
  // Spans from only some chunks would misplace words, so it is all or none.
  const tokens = timestamped ? joinChunkSpans(spanChunks) : [];
  post({ type: "audio", id: job.id, pcm, sampleRate: SAMPLE_RATE, tokens, timestamped }, [pcm.buffer]);
}

async function drain(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      if (cancelled.delete(job.id)) continue;
      try {
        await run(job);
      } catch (e) {
        post({ type: "failed", id: job.id, message: messageOf(e) });
      } finally {
        cancelled.delete(job.id);
      }
    }
  } finally {
    busy = false;
  }
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const m = event.data;
  switch (m.type) {
    case "load":
      void load(m.options);
      return;
    case "synthesise":
      queue.push({ id: m.id, text: m.text, voice: m.voice });
      void drain();
      return;
    case "cancel":
      cancelled.add(m.id);
      return;
  }
});
