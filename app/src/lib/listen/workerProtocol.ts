// Messages between the page and kokoro.worker.ts. Kept apart from the worker
// so the page side never imports kokoro-js or ONNX Runtime.

import { MODEL_HOSTS } from "./modelProbe";
import type { TimedToken, VoiceInfo } from "./types";

export type KokoroDevice = "webgpu" | "wasm";
// transformers.js maps each dtype to a file suffix (src/utils/dtypes.js): fp32
// is model.onnx, fp16 model_fp16.onnx, q8 model_quantized.onnx, q4 model_q4.onnx
// and q4f16 model_q4f16.onnx. There is no model_q8.onnx, and none is requested.
export type KokoroDtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";

export interface LoadOptions {
  /** Tried in order on each host; the first that loads is used. */
  modelIds: string[];
  /** Omitted: WebGPU when the browser has an adapter, otherwise WASM. */
  device?: KokoroDevice;
  /** Omitted: fp32 on WebGPU; q8 then fp32 on WASM (see loadPlans in the worker). */
  dtype?: KokoroDtype;
  /** Where voice files are fetched from; must serve `${voiceBase}/${voice}.bin`. A Hub URL follows the host in use. */
  voiceBase: string;
  /** Model hosts tried in order; a host that cannot be reached moves loading on to the next. Omitted: MODEL_HOSTS. */
  hosts?: string[];
  /** How long a model host has to answer a request before it counts as unreachable. Omitted: 20 seconds. */
  connectTimeoutMs?: number;
}

export type WorkerRequest =
  | { type: "load"; options: LoadOptions }
  | { type: "synthesise"; id: number; text: string; voice: string }
  | { type: "cancel"; id: number };

export type WorkerResponse =
  | { type: "progress"; file: string; loaded: number; total: number }
  | { type: "loaded"; modelId: string; device: KokoroDevice; dtype: KokoroDtype; voices: VoiceInfo[]; host?: string }
  | { type: "load-failed"; message: string; attempts?: string[] }
  | { type: "audio"; id: number; pcm: Float32Array; sampleRate: number; tokens: TimedToken[]; timestamped: boolean }
  | { type: "failed"; id: number; message: string };

export const DEFAULT_VOICE_BASE = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices";

export const DEFAULT_MODEL_HOSTS = MODEL_HOSTS;

export const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;

// Only the published model. A variant whose graph also outputs word durations
// can be added before it once it exists; until then the worker spreads words
// over each sentence's own audio (durations.ts chunkTokens).
export const DEFAULT_MODEL_IDS = ["onnx-community/Kokoro-82M-v1.0-ONNX"];

/**
 * The device and dtype pairs to try, in order. WebGPU can fail on a driver even
 * with an adapter present, so it always falls back to WASM. On WASM, q8
 * (model_quantized.onnx, about 92 MB) comes first because it is the smallest
 * file and the one kokoro-js recommends there; fp32 (model.onnx, about 326 MB)
 * follows in case the quantised graph is missing or will not run. A missing
 * file fails with one small request, so the order costs nothing when the first
 * choice is absent. A dtype asked for explicitly is tried first on its device.
 */
export function loadPlans(preferred: KokoroDevice, dtype?: KokoroDtype): Array<[KokoroDevice, KokoroDtype]> {
  const wasm: Array<[KokoroDevice, KokoroDtype]> = [["wasm", "q8"], ["wasm", "fp32"]];
  const plans: Array<[KokoroDevice, KokoroDtype]> =
    preferred === "webgpu" ? [["webgpu", dtype ?? "fp32"], ...wasm] : [...(dtype ? [["wasm", dtype] as [KokoroDevice, KokoroDtype]] : []), ...wasm];
  // The same pair twice would only repeat a failure.
  return plans.filter(([d, t], i) => plans.findIndex(([d2, t2]) => d2 === d && t2 === t) === i);
}
