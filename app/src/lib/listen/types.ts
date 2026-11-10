// Public contracts for the Listen feature. Every module in app/src/lib/listen
// and every engine (browser Kokoro worker, local Python server) speaks these
// shapes, so the player, the cache and the highlighter never depend on which
// engine produced the audio.

/** A place in the reader's own coordinate system: TextView's data-p / data-o (TextView.tsx:33). */
export interface PagePoint {
  page: number;
  /** Character offset into reflowed.pages[page].text. */
  at: number;
}

/** One stretch of script text that came from one stretch of one page, used to map back. */
export interface ScriptPiece {
  /** Offset of the piece in ListenScript.text. */
  scriptStart: number;
  length: number;
  page: number;
  /** Offset of the piece's first character in the page text. */
  pageStart: number;
}

/**
 * A paragraph, or a chunk of a long paragraph, synthesised, cached and timed on
 * its own. Paragraphs are the unit Listen plays and prefetches (script.ts).
 */
export interface Utterance {
  /** Stable index within the script, starting at 0. */
  index: number;
  /** Index of the paragraph this utterance belongs to; chunks of one long paragraph share it. */
  paragraph: number;
  /** Offsets into ListenScript.text, end exclusive. */
  start: number;
  end: number;
  text: string;
  kind: "heading" | "body";
}

/** The readable text of a document, flattened, with a way back to page offsets. */
export interface ListenScript {
  /** sha-256 hex of `text`, the cache key's first part. */
  hash: string;
  text: string;
  /** Sorted by scriptStart, non-overlapping, together covering every non-separator character. */
  pieces: ScriptPiece[];
  utterances: Utterance[];
}

/** A word of the source text, with offsets into the utterance text (end exclusive). */
export interface SourceWord {
  start: number;
  end: number;
  /** Lower-cased letters and digits only, used to compare with engine tokens. */
  norm: string;
  /** Expected relative spoken length, used when the engine gives no per-word text. */
  weight: number;
}

/** A timed unit reported by an engine, in seconds from the start of that utterance's audio. */
export interface TimedToken {
  /** The source text of the token when the engine knows it (Python misaki MToken.text), else null. */
  text: string | null;
  start: number;
  end: number;
}

/** A word the highlighter shows, in seconds on the utterance timeline. */
export interface WordTiming {
  /** Offsets into the utterance text, end exclusive. */
  start: number;
  end: number;
  t0: number;
  t1: number;
  /** "engine" when matched to an engine token, "interpolated" when estimated. */
  source: "engine" | "interpolated";
}

/** What any engine returns for one utterance. Sample rate is always 24 000 Hz for Kokoro. */
export interface SynthResult {
  sampleRate: number;
  /** Mono PCM in the range [-1, 1]. */
  pcm: Float32Array;
  tokens: TimedToken[];
  engine: EngineId;
  /** Identifies weights and code that produced the audio, part of the cache key. */
  modelVersion: string;
}

export type EngineId = "local" | "browser";

export interface VoiceInfo {
  id: string;
  name: string;
  /** BCP-47, "en-GB" or "en-US" for the voices Listen offers. */
  lang: "en-GB" | "en-US";
  gender: "Female" | "Male";
  /** Kokoro's published overall grade, such as "B-". */
  grade: string;
}

export interface TtsEngine {
  readonly id: EngineId;
  /** Resolves within the timeout or rejects; never hangs. */
  ready(timeoutMs: number): Promise<void>;
  voices(): Promise<VoiceInfo[]>;
  /** Synthesises at Kokoro speed 1.0. Playback speed is applied by the media element. */
  synthesise(text: string, voice: string, signal: AbortSignal): Promise<SynthResult>;
}

/** One encoded utterance, as stored in Dexie table `listenAudio`. */
export interface EncodedUtterance {
  /** `${script.hash}:${voice}:${modelVersion}:${utterance.index}` */
  key: string;
  mp3: Blob;
  /** Decoded length of the MP3 in samples: frames × samplesPerFrame. Exact, from frame headers. */
  samples: number;
  sampleRate: number;
  words: WordTiming[];
  createdAt: number;
  lastUsedAt: number;
}

/** A word placed on the continuous playback timeline. */
export interface TimelineWord {
  utterance: number;
  /** Offsets into ListenScript.text. */
  start: number;
  end: number;
  t0: number;
  t1: number;
}

export interface PlaybackTimeline {
  /** Start time of each utterance on the continuous stream, seconds. Length = rendered utterances. */
  utteranceStarts: number[];
  words: TimelineWord[];
  /** Total rendered duration, seconds. */
  duration: number;
}

export type PlayerState = "idle" | "preparing" | "playing" | "paused" | "buffering" | "ended" | "error";

export interface ListenSettings {
  engine: "auto" | EngineId;
  voice: string;
  /** Media element playbackRate, clamped to [MIN_RATE, MAX_RATE]. */
  rate: number;
  followText: boolean;
  /** Base URL of backend/tts, such as http://localhost:8765. Empty when not configured. */
  localUrl: string;
  /** Bearer token for backend/tts when it is reachable beyond localhost. */
  localToken: string;
}

/** Gradual speed up, as Speechify offers: a little faster every paragraph or every minute, up to a cap. */
export interface RampSettings {
  enabled: boolean;
  /** Added to the speed at each step, such as 0.05. */
  step: number;
  every: "paragraph" | "minute";
  /** The most the ramp adds above the speed it started from, such as 0.5. */
  maxBoost: number;
}

export const MIN_RATE = 0.5;
export const MAX_RATE = 3.5;
export const DEFAULT_VOICE = "bf_emma";
export const DEFAULT_VOICES: VoiceInfo[] = [
  { id: "bf_emma", name: "Emma", lang: "en-GB", gender: "Female", grade: "A" },
  { id: "bm_george", name: "George", lang: "en-GB", gender: "Male", grade: "B" },
  { id: "bm_lewis", name: "Lewis", lang: "en-GB", gender: "Male", grade: "B" },
  { id: "bf_isabella", name: "Isabella", lang: "en-GB", gender: "Female", grade: "B" },
  { id: "af_heart", name: "Heart", lang: "en-US", gender: "Female", grade: "A" },
  { id: "am_adam", name: "Adam", lang: "en-US", gender: "Male", grade: "B" },
];
export const KOKORO_SAMPLE_RATE = 24_000;
