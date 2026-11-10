// Messages between the page and kokoro.worker.ts. Kept apart from the worker
// so the page side never imports kokoro-js or ONNX Runtime.

import type { TimedToken, VoiceInfo } from "./types";

export type KokoroDevice = "webgpu" | "wasm";
export type KokoroDtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";

export interface LoadOptions {
  /** Tried in order; the first that loads is used. A timestamped variant first gives word durations. */
  modelIds: string[];
  /** Omitted: WebGPU when the browser has an adapter, otherwise WASM. */
  device?: KokoroDevice;
  /** Omitted: fp32 on WebGPU, q8 on WASM, as kokoro-js recommends. */
  dtype?: KokoroDtype;
  /** Where voice files are fetched from; must serve `${voiceBase}/${voice}.bin`. */
  voiceBase: string;
}

export type WorkerRequest =
  | { type: "load"; options: LoadOptions }
  | { type: "synthesise"; id: number; text: string; voice: string }
  | { type: "cancel"; id: number };

export type WorkerResponse =
  | { type: "progress"; file: string; loaded: number; total: number }
  | { type: "loaded"; modelId: string; device: KokoroDevice; dtype: KokoroDtype; voices: VoiceInfo[] }
  | { type: "load-failed"; message: string }
  | { type: "audio"; id: number; pcm: Float32Array; sampleRate: number; tokens: TimedToken[]; timestamped: boolean }
  | { type: "failed"; id: number; message: string };

export const DEFAULT_VOICE_BASE = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices";

export const DEFAULT_MODEL_IDS = [
  // Unverified from this sandbox: a variant whose graph also outputs `durations` (open risk R3).
  "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped",
  "onnx-community/Kokoro-82M-v1.0-ONNX",
];
