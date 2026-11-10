// Type definitions for kokoro-js and @huggingface/transformers for Listen Web Worker

declare module "kokoro-js" {
  export interface KokoroVoice {
    name: string;
    language: string;
    gender: string;
    overallGrade: string;
    [key: string]: unknown;
  }

  export interface KokoroStreamPart {
    /** The sentence this chunk speaks; kokoro-js splits text into sentences itself. */
    text: string;
    audio: {
      audio: Float32Array;
      sampling_rate: number;
    };
    phonemes: string;
  }

  /** kokoro-js re-exports only wasmPaths, written straight into its own transformers.js copy. */
  export const env: { wasmPaths: unknown };

  export class KokoroTTS {
    voices: Record<string, KokoroVoice>;
    model: unknown;
    tokenizer: unknown;
    static from_pretrained(
      modelId: string,
      options?: {
        dtype?: string;
        device?: string;
        progress_callback?: (progress: unknown) => void;
      },
    ): Promise<KokoroTTS>;
    generate_from_ids(
      ids: unknown,
      options?: { voice?: string; speed?: number },
    ): Promise<unknown>;
    stream(
      text: string,
      options?: { voice?: string; speed?: number },
    ): AsyncIterable<KokoroStreamPart>;
  }
}

declare module "@huggingface/transformers" {
  export class Tensor {
    type: string;
    data: Float32Array | Float64Array | Int32Array | BigInt64Array | unknown[];
    dims: number[];
    constructor(type: string, data: unknown, dims?: number[]);
  }

  export class RawAudio {
    data: Float32Array;
    sampling_rate: number;
    constructor(data: Float32Array, sampling_rate: number);
  }
}
