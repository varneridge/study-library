// The browser engine: Kokoro in kokoro.worker.ts, behind the TtsEngine
// contract (types.ts), so the player treats it exactly like the local server.

import type { SynthResult, TtsEngine, VoiceInfo } from "./types";
import { DEFAULT_MODEL_IDS, DEFAULT_VOICE_BASE, type LoadOptions, type WorkerRequest, type WorkerResponse } from "./workerProtocol";

/** The parts of a Worker this engine uses, so tests can pass a fake one. */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerResponse>) => void): void;
  addEventListener(type: "error", listener: (event: Event) => void): void;
  terminate(): void;
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
    this.options = options.load ?? { modelIds: DEFAULT_MODEL_IDS, voiceBase: DEFAULT_VOICE_BASE };
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
            this.fail(new Error(`Kokoro could not load: ${m.message}`), reject);
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
      worker.addEventListener("error", () => this.fail(new Error("the speech worker stopped"), reject));
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
      const timer = setTimeout(() => reject(new Error(`Kokoro did not load within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
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
