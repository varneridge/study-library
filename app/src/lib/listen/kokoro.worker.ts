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
//
// Loading. kokoro-js 1.2.1 depends on @huggingface/transformers ^3.5.1 (its
// package.json), so importing transformers 3.3.3 beside it gave a second copy
// of the library: its env settings did not reach the copy kokoro-js loads
// models with, and its Tensor class was foreign to kokoro-js's ONNX session.
// This worker imports kokoro-js with its transformers dependency pinned, takes
// the Tensor class from kokoro-js's own input tensors, and configures
// transformers' env only after proving it is the copy kokoro-js uses.
//
// Hosts. Loading goes straight to from_pretrained: nothing is probed first, as a
// probe that failed for its own reasons used to stop a model that would have
// loaded. Each model host in LoadOptions.hosts is tried in turn (the Hub, then
// a mirror). Requests are routed by rewriting canonical Hub URLs in this
// worker's fetch (modelProbe.ts mirrorUrl), which reaches whichever
// transformers.js copy kokoro-js uses and the voice loader alike, and keeps the
// canonical URLs as Cache Storage keys. Only when every host has failed are the
// hosts probed, to name the cause in the message the reader sees.

import type { KokoroTTS, KokoroVoice } from "kokoro-js";
import type { Tensor } from "@huggingface/transformers";
import { chunkTokens, joinChunkSpans, spansFromDurations } from "./durations";
import { explainProbes, HUB, isNetworkFailure, mirrorUrl, normaliseHost, probeModel } from "./modelProbe";
import type { TimedToken, VoiceInfo } from "./types";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MODEL_HOSTS,
  loadPlans,
  type KokoroDevice,
  type LoadOptions,
  type WorkerRequest,
  type WorkerResponse,
} from "./workerProtocol";

declare const self: DedicatedWorkerGlobalScope;

// CSP violations seen in this worker. A worker has its own policy, from its own
// script's response, so the page's console may not show what this worker was
// refused; collecting the events lets the error name the blocked origin.
const violations: string[] = [];
self.addEventListener("securitypolicyviolation", (event: Event) => {
  const e = event as Event & { effectiveDirective?: string; blockedURI?: string };
  violations.push(`${e.effectiveDirective ?? "csp"} blocked ${e.blockedURI ?? "a request"}`);
});

// The model host in use. Hub URLs are sent here instead while it is a mirror.
let activeHost = normaliseHost(HUB);
let connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS;
const nativeFetch: typeof fetch = self.fetch.bind(self);

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * fetch with a limit on how long a host may take to answer. Only the wait for
 * the response headers is limited; once they arrive the timer stops, so a large
 * model download is never cut short by it.
 */
async function fetchWithAnswerLimit(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (init?.signal || connectTimeoutMs <= 0) return nativeFetch(input, init);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), connectTimeoutMs);
  try {
    return await nativeFetch(input, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) {
      let origin = urlOf(input);
      try {
        origin = new URL(origin).origin;
      } catch {
        // Keep the URL as it was given.
      }
      throw new TypeError(`${origin} gave no answer within ${Math.round(connectTimeoutMs / 1000)} s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Every request for a Hub file, from transformers.js or from voiceData below,
// goes to the active host. Other requests (kokoro-js's code, ONNX Runtime's
// WASM) pass through untouched.
self.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = urlOf(input);
  if (!url.startsWith(HUB)) return nativeFetch(input, init);
  const target = mirrorUrl(url, activeHost);
  const request = target === url || typeof input === "string" || input instanceof URL ? target : new Request(target, input);
  return fetchWithAnswerLimit(request, init);
}) as typeof fetch;

const SAMPLE_RATE = 24_000;
const STYLE_DIM = 256;
// kokoro-js truncates input to 510 tokens and picks the style row by length (dist/kokoro.js, generate_from_ids).
const MAX_STYLE_ROW = 509;

interface Job {
  id: number;
  text: string;
  voice: string;
}

/** The transformers version kokoro-js 1.2.1's range resolves to, pinned so both imports are one copy. */
const TRANSFORMERS_VERSION = "3.8.1";

/** Where kokoro-js is imported from, tried in order, each with the matching transformers module. */
export const MODULE_SOURCES: Array<{ kokoro: string; transformers: string }> = [
  {
    kokoro: `https://esm.sh/kokoro-js@1.2.1?deps=@huggingface/transformers@${TRANSFORMERS_VERSION}`,
    transformers: `https://esm.sh/@huggingface/transformers@${TRANSFORMERS_VERSION}`,
  },
  {
    kokoro: "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm",
    transformers: `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/+esm`,
  },
];

interface KokoroEnv {
  wasmPaths: unknown;
}

interface TransformersEnv {
  allowLocalModels?: boolean;
  useBrowserCache?: boolean;
  useFS?: boolean;
  useFSCache?: boolean;
  backends?: { onnx?: { wasm?: { wasmPaths?: unknown; numThreads?: number; proxy?: boolean } } };
}

let KokoroTTSClass: typeof KokoroTTS | null = null;

/**
 * Whether `hf` is the transformers copy kokoro-js uses. kokoro-js's own `env`
 * only exposes wasmPaths, which it writes straight into its transformers copy
 * (dist/kokoro.js), so a value written there and read back here proves it.
 */
function sameCopy(kokoroEnv: KokoroEnv, hf: TransformersEnv): boolean {
  const wasm = hf.backends?.onnx?.wasm;
  if (!wasm) return false;
  const before = kokoroEnv.wasmPaths;
  const probe = `listen-probe-${Math.random().toString(36).slice(2)}`;
  try {
    kokoroEnv.wasmPaths = probe;
    return wasm.wasmPaths === probe;
  } finally {
    kokoroEnv.wasmPaths = before;
  }
}

/** Settings for a worker: no local model paths, the Cache API for weights, one WASM thread, no proxy worker. */
function configure(hf: TransformersEnv): void {
  hf.allowLocalModels = false;
  hf.useBrowserCache = true;
  // A CDN build may polyfill Node's fs; a browser never has a file system to use.
  if ("useFS" in hf) hf.useFS = false;
  if ("useFSCache" in hf) hf.useFSCache = false;
  const wasm = hf.backends?.onnx?.wasm;
  if (wasm) {
    wasm.numThreads = 1;
    wasm.proxy = false;
  }
}

async function ensureModules(): Promise<void> {
  if (KokoroTTSClass) return;
  const failures: string[] = [];
  for (const source of MODULE_SOURCES) {
    try {
      const k = (await import(/* @vite-ignore */ source.kokoro)) as { KokoroTTS: typeof KokoroTTS; env: KokoroEnv };
      try {
        const h = (await import(/* @vite-ignore */ source.transformers)) as { env: TransformersEnv };
        if (sameCopy(k.env, h.env)) configure(h.env);
        else console.warn("Listen: transformers.js is not the copy kokoro-js uses; its defaults stay in place.");
      } catch (e) {
        console.warn(`Listen: transformers.js settings not applied (${messageOf(e)}); its defaults stay in place.`);
      }
      KokoroTTSClass = k.KokoroTTS;
      return;
    } catch (e) {
      failures.push(`${new URL(source.kokoro).host}: ${messageOf(e)}`);
    }
  }
  throw new Error(`Kokoro's code could not be downloaded (${failures.join("; ")})`);
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
  ): Promise<{ audio: Float32Array; sampling_rate: number }> => {
    // The input ids are kokoro-js's own Tensor, so their class is the one its ONNX session accepts.
    const TensorOfModel = ids.constructor as new (type: string, data: unknown, dims: number[]) => Tensor;
    const row = Math.min(Math.max(Number(ids.dims[ids.dims.length - 1]) - 2, 0), MAX_STYLE_ROW);
    const data = await voiceData(voice);
    const style = data.slice(STYLE_DIM * row, STYLE_DIM * row + STYLE_DIM);
    const out = await graph({
      input_ids: ids,
      style: new TensorOfModel("float32", style, [1, STYLE_DIM]),
      speed: new TensorOfModel("float32", [speed], [1]),
    });
    // Durations come as int64 (BigInt64Array) from most exports, so convert element by element.
    lastDurations = out.durations ? Float64Array.from(out.durations.data as ArrayLike<number | bigint>, (x) => Number(x)) : null;
    // kokoro-js's stream() passes this straight through as `audio`; run() reads only these two fields.
    return { audio: out.waveform.data as Float32Array, sampling_rate: SAMPLE_RATE };
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
  try {
    await ensureModules();
  } catch (e) {
    post({ type: "load-failed", message: messageOf(e), attempts: [messageOf(e)] });
    return;
  }
  if (!KokoroTTSClass) {
    post({ type: "load-failed", message: "Kokoro's code could not be loaded." });
    return;
  }
  voiceBase = options.voiceBase.replace(/\/+$/, "");
  connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const hosts = [...new Set((options.hosts?.length ? options.hosts : DEFAULT_MODEL_HOSTS).map(normaliseHost))];
  const plans = loadPlans(await pickDevice(options.device), options.dtype);
  const attempts: string[] = [];
  for (const host of hosts) {
    activeHost = host;
    const where = new URL(host).host;
    let unreachable = false;
    for (const modelId of options.modelIds) {
      for (const [device, dtype] of plans) {
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
          post({ type: "loaded", modelId, device, dtype, voices: voiceList(model), host });
          return;
        } catch (e) {
          const message = messageOf(e);
          attempts.push(`${modelId} (${dtype} on ${device}) from ${where}: ${message}`);
          // A host that cannot be reached will not answer for another dtype either.
          if (isNetworkFailure(message)) {
            unreachable = true;
            break;
          }
        }
      }
      if (unreachable) break;
    }
  }
  activeHost = hosts[0] ?? normaliseHost(HUB);
  post({ type: "load-failed", message: await explainFailure(options.modelIds[0] ?? "", hosts, attempts), attempts });
}

/**
 * Why loading failed. When every attempt was a network failure, each host is
 * probed directly (no host rewriting, the same plain GET transformers.js
 * makes) so the message names the hosts and the likely cause; otherwise the
 * attempts themselves say what went wrong.
 */
async function explainFailure(modelId: string, hosts: string[], attempts: string[]): Promise<string> {
  const allNetwork = attempts.length > 0 && attempts.every((a) => isNetworkFailure(a));
  if (!allNetwork || !modelId) return `Kokoro could not load: ${attempts.join("; ") || "no model was tried"}`;
  const probes = await Promise.all(hosts.map((h) => probeModel(modelId, (url, init) => fetchWithAnswerLimit(url, init), () => violations, `${h}/`)));
  if (probes.some((p) => p.ok)) return `Kokoro could not load: ${attempts.join("; ")}`;
  return explainProbes(probes);
}

async function run(job: Job): Promise<void> {
  if (!tts) throw new Error("the model is not loaded");
  const pcmChunks: Float32Array[] = [];
  const spanChunks: Array<{ spans: TimedToken[]; seconds: number }> = [];
  const textChunks: Array<{ text: string; seconds: number }> = [];
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
    textChunks.push({ text: part.text ?? "", seconds });
  }
  const pcm = new Float32Array(pcmChunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of pcmChunks) {
    pcm.set(c, o);
    o += c.length;
  }
  // Spans from only some chunks would misplace words, so it is all or none. Without
  // the model's durations, words are spread over their own sentence's audio.
  const tokens = timestamped ? joinChunkSpans(spanChunks) : chunkTokens(textChunks);
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
