// The Web Speech API as Listen's fallback voice. When Kokoro cannot load (no
// network, the model host blocked, no WebGPU or WASM), the controller reads with
// the device's own voice instead, so listening is never blocked. It has no audio
// file to seek in and no lock-screen playback, but it highlights word by word
// through boundary events where the voice reports them.
//
// The shapes below are the parts of speechSynthesis and SpeechSynthesisUtterance
// the controller uses, so tests can pass a fake.

export interface SpeechVoiceLike {
  name: string;
  lang: string;
  default?: boolean;
}

export interface SpeechUtteranceLike {
  text: string;
  rate: number;
  lang: string;
  voice: SpeechVoiceLike | null;
  onboundary: ((event: { name?: string; charIndex: number }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}

export interface SpeechSynthesisLike {
  speak(utterance: SpeechUtteranceLike): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  getVoices(): SpeechVoiceLike[];
}

export interface SpeechBackend {
  synth: SpeechSynthesisLike;
  make(text: string): SpeechUtteranceLike;
}

/** The browser's speech synthesis, or null where there is none (a worker, an old browser, a test). */
export function browserSpeech(): SpeechBackend | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return null;
  return {
    synth: window.speechSynthesis as unknown as SpeechSynthesisLike,
    make: (text) => new SpeechSynthesisUtterance(text) as unknown as SpeechUtteranceLike,
  };
}

/** A British English voice first, then any English voice, then the device default. */
export function pickSpeechVoice(voices: SpeechVoiceLike[]): SpeechVoiceLike | null {
  const lower = (v: SpeechVoiceLike) => v.lang.toLowerCase().replace("_", "-");
  return (
    voices.find((v) => lower(v) === "en-gb") ??
    voices.find((v) => lower(v).startsWith("en")) ??
    voices.find((v) => v.default) ??
    voices[0] ??
    null
  );
}

/** Errors a synthesis engine reports when it cannot run at all, rather than failing one utterance. */
export function isEngineUnavailable(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  if (!e) return false;
  if (e.name === "KokoroLoadError") return true;
  return /Kokoro (could|did) not load|speech worker stopped|Failed to fetch|NetworkError|Load failed|could not be reached/i.test(e.message ?? "");
}
