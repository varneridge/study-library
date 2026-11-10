// The browser engine: Kokoro in kokoro.worker.ts, behind the TtsEngine
// contract (types.ts), so the player treats it exactly like the local server.

import type { SynthResult, TtsEngine, VoiceInfo } from "./types";
import { DEFAULT_MODEL_HOSTS, DEFAULT_MODEL_IDS, DEFAULT_VOICE_BASE, type KokoroDevice, type LoadOptions, type WorkerRequest, type WorkerResponse } from "./workerProtocol";

/** The parts of a Worker this engine uses, so tests can pass a fake one. */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerResponse>) => void): void;
  addEventListener(type: "error", listener: (event: Event) => void): void;
  terminate(): void;
}

/**
 * Kokoro cannot run at all (its code or model could not be fetched, the worker
 * stopped, it did not load in time), as opposed to one utterance failing. The
 * controller falls back to the device's voice on this error (speech.ts).
 */
export class KokoroLoadError extends Error {
  readonly attempts: string[];
  constructor(message: string, attempts: string[] = []) {
    super(message);
    this.name = "KokoroLoadError";
    this.attempts = attempts;
  }
}

interface Loaded {
  modelVersion: string;
  voices: VoiceInfo[];
}

export interface BrowserEngineOptions {
  load?: LoadOptions;
  makeWorker?: () => WorkerLike;
  onProgress?: (file: string, loaded: number, total: number) => void;
}

/**
 * This app's own model route first (worker/models.ts), then Hugging Face and
 * its mirror. The browser was refused the model by huggingface.co and
 * hf-mirror.com, whose responses arrived without CORS headers; a request to
 * the app's own origin needs no CORS, so it works wherever the app itself does.
 */
function defaultHosts(): string[] {
  const origin = typeof location !== "undefined" && /^https?:$/.test(location.protocol) ? location.origin : null;
  return origin ? [`${origin}/api/models`, ...DEFAULT_MODEL_HOSTS] : [...DEFAULT_MODEL_HOSTS];
}

/** Where a reader can choose the device: localStorage "listen-device", "wasm" or "webgpu". */
export const DEVICE_KEY = "listen-device";

/**
 * WASM unless the reader has chosen WebGPU. On some Windows graphics drivers
 * Kokoro's vocoder can compute wrongly on WebGPU, so its speech comes out as a
 * buzz, with no error to fall back on, so the GPU cannot be chosen
 * automatically. WASM also needs the 92 MB q8 model rather than the 326 MB fp32
 * one. Where WebGPU is known to sound right, setting the key to "webgpu" uses it.
 */
function preferredDevice(): KokoroDevice {
  try {
    const chosen = globalThis.localStorage?.getItem(DEVICE_KEY);
    if (chosen === "webgpu" || chosen === "wasm") return chosen;
  } catch {
    // Storage can be refused (private browsing); the default stands.
  }
  return "wasm";
}

export class BrowserKokoroEngine implements TtsEngine {
  readonly id = "browser" as const;
  private readonly options: LoadOptions;
  private readonly makeWorker: () => WorkerLike;
  private readonly onProgress?: BrowserEngineOptions["onProgress"];
  private worker: WorkerLike | null = null;
  private loading: Promise<Loaded> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: SynthResult) => void; reject: (e: Error) => void }>();
  private loaded: Loaded | null = null;
  /** Whether the last utterance came with durations from the model, for the settings screen. */
  timestamped: boolean | null = null;

  constructor(options: BrowserEngineOptions = {}) {
    this.options = options.load ?? { modelIds: DEFAULT_MODEL_IDS, voiceBase: DEFAULT_VOICE_BASE, hosts: defaultHosts(), device: preferredDevice() };
    this.makeWorker =
      options.makeWorker ?? (() => new Worker(new URL("./kokoro.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike);
    this.onProgress = options.onProgress;
  }

  private start(): Promise<Loaded> {
    if (this.loading) return this.loading;
    this.loading = new Promise<Loaded>((resolve, reject) => {
      const worker = this.makeWorker();
      this.worker = worker;
      worker.addEventListener("message", (event) => {
        const m = event.data;
        switch (m.type) {
          case "progress":
            this.onProgress?.(m.file, m.loaded, m.total);
            return;
          case "loaded":
            this.loaded = { modelVersion: `${m.modelId}@${m.dtype}`, voices: m.voices };
            resolve(this.loaded);
            return;
          case "load-failed":
            // The worker's message already explains the failure; it is not prefixed twice.
            this.fail(new KokoroLoadError(m.message.startsWith("Kokoro") ? m.message : `Kokoro could not load: ${m.message}`, m.attempts ?? []), reject);
            return;
          case "audio": {
            const job = this.pending.get(m.id);
            if (!job) return; // cancelled after it finished
            this.pending.delete(m.id);
            this.timestamped = m.timestamped;
            job.resolve({ sampleRate: m.sampleRate, pcm: m.pcm, tokens: m.tokens, engine: "browser", modelVersion: this.loaded?.modelVersion ?? "" });
            return;
          }
          case "failed": {
            const job = this.pending.get(m.id);
            this.pending.delete(m.id);
            job?.reject(new Error(m.message));
            return;
          }
        }
      });
      worker.addEventListener("error", () => this.fail(new KokoroLoadError("Kokoro could not load: the speech worker stopped"), reject));
      worker.postMessage({ type: "load", options: this.options });
    });
    return this.loading;
  }

  /** A dead worker fails everything waiting on it, and the next call starts a new one. */
  private fail(error: Error, reject: (e: Error) => void): void {
    reject(error);
    for (const job of this.pending.values()) job.reject(error);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.loading = null;
    this.loaded = null;
  }

  ready(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new KokoroLoadError(`Kokoro did not load within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
      this.start().then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  async voices(): Promise<VoiceInfo[]> {
    return (await this.start()).voices;
  }

  async synthesise(text: string, voice: string, signal: AbortSignal): Promise<SynthResult> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    await this.start();
    const worker = this.worker;
    if (!worker) throw new Error("the speech worker is not running");
    const id = this.nextId++;
    return new Promise<SynthResult>((resolve, reject) => {
      const abort = () => {
        if (!this.pending.delete(id)) return;
        worker.postMessage({ type: "cancel", id });
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (r) => {
          signal.removeEventListener("abort", abort);
          resolve(r);
        },
        reject: (e) => {
          signal.removeEventListener("abort", abort);
          reject(e);
        },
      });
      worker.postMessage({ type: "synthesise", id, text, voice });
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.loading = null;
    for (const job of this.pending.values()) job.reject(new Error("the speech engine was closed"));
    this.pending.clear();
  }
}
