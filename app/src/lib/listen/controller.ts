// ListenController: orchestrates speech synthesis, audio playback,
// Speechify-style word highlighting, speed control, voice selection,
// and background playback via MediaSession API.

import { alignWords } from "./align";
import { type HighlightPainter, type RunIndex, FollowGate, scrollDelta } from "./highlight";
import {
  pageToScript,
  scriptRangeToPageRanges,
  scriptToPage,
  utteranceAt,
} from "./script";
import type {
  EngineId,
  ListenScript,
  PagePoint,
  PlayerState,
  TtsEngine,
  WordTiming,
} from "./types";
import { DEFAULT_VOICE, MAX_RATE, MIN_RATE } from "./types";
import { pcmToWav } from "./wav";

export interface ListenSnapshot {
  state: PlayerState;
  mode: "stream" | "edition";
  utterance: number;
  word: number;
  rate: number;
  voice: string;
  engine: EngineId;
  bufferedSeconds: number;
  error: string | null;
  totalUtterances: number;
  currentPage: number;
}

export interface ListenController {
  play(from?: PagePoint): Promise<void>;
  pause(): void;
  seekToOffset(scriptOffset: number): void;
  skipSentences(n: number): void;
  setRate(rate: number): void;
  setVoice(voice: string): Promise<void>;
  prepareEdition(
    maxSeconds: number,
    onProgress: (done: number, total: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  subscribe(listener: (s: ListenSnapshot) => void): () => void;
  dispose(): void;
  getSnapshot(): ListenSnapshot;
}

interface UtteranceAudio {
  url: string;
  blob: Blob;
  duration: number;
  words: WordTiming[];
  pcm: Float32Array;
}

export function createListenController(deps: {
  script: ListenScript;
  engine: TtsEngine;
  audio?: HTMLAudioElement;
  title: string;
  album: string;
  painter?: HighlightPainter;
  index?: RunIndex;
  scroller?: HTMLElement;
  onPageChange?: (page: number) => void;
}): ListenController {
  const { script, engine, title, album, painter, index, scroller, onPageChange } = deps;
  const audio = deps.audio ?? new Audio();
  const followGate = new FollowGate();

  let state: PlayerState = "idle";
  let mode: "stream" | "edition" = "stream";
  let currentUtteranceIndex = 0;
  let currentWordIndex = -1;
  let rate = 1.0;
  let voice = DEFAULT_VOICE;
  let errorMsg: string | null = null;

  const audioCache = new Map<number, UtteranceAudio>();
  const inFlight = new Map<number, Promise<UtteranceAudio>>();
  const subscribers = new Set<(s: ListenSnapshot) => void>();
  let abortController: AbortController | null = null;
  let activeUrl: string | null = null;

  function emit(): void {
    const snap = getSnapshot();
    for (const sub of subscribers) {
      try {
        sub(snap);
      } catch (err) {
        console.error("Subscriber error:", err);
      }
    }
  }

  function getSnapshot(): ListenSnapshot {
    const utt = script.utterances[currentUtteranceIndex];
    const page = utt ? (scriptToPage(script, utt.start)?.page ?? 0) : 0;
    return {
      state,
      mode,
      utterance: currentUtteranceIndex,
      word: currentWordIndex,
      rate,
      voice,
      engine: engine.id,
      bufferedSeconds: 0,
      error: errorMsg,
      totalUtterances: script.utterances.length,
      currentPage: page,
    };
  }

  function setupMediaSession(): void {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist: "Kokoro Speech",
        album: album || "Study Library",
      });

      navigator.mediaSession.setActionHandler("play", () => void play());
      navigator.mediaSession.setActionHandler("pause", () => pause());
      navigator.mediaSession.setActionHandler("previoustrack", () => skipSentences(-1));
      navigator.mediaSession.setActionHandler("nexttrack", () => skipSentences(1));
      navigator.mediaSession.setActionHandler("seekbackward", () => {
        audio.currentTime = Math.max(0, audio.currentTime - 10);
      });
      navigator.mediaSession.setActionHandler("seekforward", () => {
        audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10);
      });
    } catch {
      // mediaSession actions unsupported in some contexts
    }
  }

  async function fetchUtterance(idx: number, signal: AbortSignal): Promise<UtteranceAudio> {
    if (audioCache.has(idx)) {
      return audioCache.get(idx)!;
    }
    if (inFlight.has(idx)) {
      return inFlight.get(idx)!;
    }

    const utt = script.utterances[idx];
    if (!utt) throw new Error(`Utterance out of range: ${idx}`);

    const promise = (async () => {
      const result = await engine.synthesise(utt.text, voice, signal);
      const duration = result.pcm.length / result.sampleRate;
      const words = alignWords(utt.text, result.tokens, duration);
      const blob = pcmToWav(result.pcm, result.sampleRate);
      const url = URL.createObjectURL(blob);

      const entry: UtteranceAudio = { url, blob, duration, words, pcm: result.pcm };
      audioCache.set(idx, entry);
      inFlight.delete(idx);
      return entry;
    })();

    inFlight.set(idx, promise);
    return promise;
  }

  function prefetchUpcoming(currentIndex: number): void {
    if (mode === "edition") return;
    const prefetchCount = 3;
    for (let i = 1; i <= prefetchCount; i += 1) {
      const idx = currentIndex + i;
      if (idx < script.utterances.length && !audioCache.has(idx) && !inFlight.has(idx)) {
        const ctrl = new AbortController();
        void fetchUtterance(idx, ctrl.signal).catch(() => {});
      }
    }
  }

  async function playUtterance(idx: number): Promise<void> {
    if (idx >= script.utterances.length) {
      state = "ended";
      painter?.clear();
      emit();
      return;
    }

    currentUtteranceIndex = idx;
    currentWordIndex = -1;
    state = "buffering";
    emit();

    const utt = script.utterances[idx];
    if (utt && onPageChange) {
      const page = scriptToPage(script, utt.start)?.page ?? 0;
      onPageChange(page);
    }

    abortController?.abort();
    abortController = new AbortController();

    try {
      const audioData = await fetchUtterance(idx, abortController.signal);
      if (activeUrl && activeUrl !== audioData.url && mode === "stream") {
        URL.revokeObjectURL(activeUrl);
      }
      activeUrl = audioData.url;

      audio.src = audioData.url;
      audio.playbackRate = rate;
      audio.preservesPitch = true;

      await audio.play();
      state = "playing";
      emit();

      prefetchUpcoming(idx);
    } catch (err: unknown) {
      if ((err as Error)?.name === "AbortError") return;
      console.error("Playback error:", err);
      errorMsg = (err as Error)?.message ?? "Audio playback failed";
      // Skip failed utterance gracefully
      if (idx + 1 < script.utterances.length) {
        void playUtterance(idx + 1);
      } else {
        state = "error";
        emit();
      }
    }
  }

  // Audio element listeners
  audio.ontimeupdate = () => {
    if (mode === "edition") return;
    const uttAudio = audioCache.get(currentUtteranceIndex);
    const utt = script.utterances[currentUtteranceIndex];
    if (!uttAudio || !utt) return;

    const t = audio.currentTime;
    let wordIdx = -1;
    for (let i = 0; i < uttAudio.words.length; i += 1) {
      const w = uttAudio.words[i];
      if (t >= w.t0 && t <= w.t1) {
        wordIdx = i;
        break;
      }
      if (t > w.t1) {
        wordIdx = i; // keep previous word lit across micro pauses
      }
    }

    if (wordIdx !== currentWordIndex && wordIdx >= 0) {
      currentWordIndex = wordIdx;
      const w = uttAudio.words[wordIdx];
      if (w && painter && index) {
        const wordPoints = scriptRangeToPageRanges(script, utt.start + w.start, utt.start + w.end);
        const sentPoints = scriptRangeToPageRanges(script, utt.start, utt.end);

        const wordRange = index.range(wordPoints);
        const sentRange = index.range(sentPoints);

        painter.show("word", wordRange);
        painter.show("sentence", sentRange);

        if (wordRange && scroller && followGate.follows(performance.now())) {
          const rect = wordRange.getBoundingClientRect();
          const scrollerRect = scroller.getBoundingClientRect();
          const delta = scrollDelta(
            { top: rect.top, bottom: rect.bottom },
            { top: scrollerRect.top, height: scrollerRect.height },
          );
          if (Math.abs(delta) > 1) {
            scroller.scrollTop += delta;
          }
        }
      }
      emit();
    }
  };

  audio.onended = () => {
    if (mode === "stream") {
      void playUtterance(currentUtteranceIndex + 1);
    } else {
      state = "ended";
      painter?.clear();
      emit();
    }
  };

  audio.onpause = () => {
    if (state === "playing") {
      state = "paused";
      emit();
    }
  };

  audio.onplay = () => {
    if (state === "paused") {
      state = "playing";
      emit();
    }
  };

  async function play(from?: PagePoint): Promise<void> {
    setupMediaSession();
    if (from) {
      const scriptOffset = pageToScript(script, from);
      if (scriptOffset !== null) {
        const uIdx = utteranceAt(script.utterances, scriptOffset);
        if (uIdx >= 0) {
          await playUtterance(uIdx);
          return;
        }
      }
    }

    if (state === "paused" && audio.src) {
      await audio.play();
      state = "playing";
      emit();
      return;
    }

    await playUtterance(currentUtteranceIndex);
  }

  function pause(): void {
    audio.pause();
    state = "paused";
    emit();
  }

  function seekToOffset(scriptOffset: number): void {
    const uIdx = utteranceAt(script.utterances, scriptOffset);
    if (uIdx >= 0) {
      void playUtterance(uIdx);
    }
  }

  function skipSentences(n: number): void {
    const nextIdx = Math.max(0, Math.min(script.utterances.length - 1, currentUtteranceIndex + n));
    void playUtterance(nextIdx);
  }

  function setRate(newRate: number): void {
    const clamped = Math.max(MIN_RATE, Math.min(MAX_RATE, newRate));
    rate = clamped;
    audio.playbackRate = clamped;
    audio.preservesPitch = true;
    emit();
  }

  async function setVoice(newVoice: string): Promise<void> {
    if (voice === newVoice) return;
    voice = newVoice;
    // Invalidate cached upcoming audio
    for (const [idx, data] of audioCache.entries()) {
      if (idx > currentUtteranceIndex) {
        URL.revokeObjectURL(data.url);
        audioCache.delete(idx);
      }
    }
    emit();
  }

  async function prepareEdition(
    maxSeconds: number,
    onProgress: (done: number, total: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    pause();
    mode = "edition";
    state = "preparing";
    emit();

    const parts: Float32Array[] = [];
    let accumulatedSeconds = 0;
    const startIndex = currentUtteranceIndex;
    const endIndex = script.utterances.length;

    for (let i = startIndex; i < endIndex; i += 1) {
      if (signal.aborted) break;
      const utt = await fetchUtterance(i, signal);
      parts.push(utt.pcm);
      accumulatedSeconds += utt.duration;
      onProgress(i - startIndex + 1, endIndex - startIndex);
      if (accumulatedSeconds >= maxSeconds) break;
    }

    // Join all parts into one continuous WAV
    const totalSamples = parts.reduce((acc, p) => acc + p.length, 0);
    const merged = new Float32Array(totalSamples);
    let offset = 0;
    for (const p of parts) {
      merged.set(p, offset);
      offset += p.length;
    }

    const editionBlob = pcmToWav(merged, 24000);
    const editionUrl = URL.createObjectURL(editionBlob);

    if (activeUrl) URL.revokeObjectURL(activeUrl);
    activeUrl = editionUrl;
    audio.src = editionUrl;
    audio.playbackRate = rate;
    audio.preservesPitch = true;

    state = "paused";
    emit();
  }

  function subscribe(listener: (s: ListenSnapshot) => void): () => void {
    subscribers.add(listener);
    listener(getSnapshot());
    return () => {
      subscribers.delete(listener);
    };
  }

  function dispose(): void {
    subscribers.clear();
    audio.pause();
    audio.ontimeupdate = null;
    audio.onended = null;
    audio.onpause = null;
    audio.onplay = null;
    abortController?.abort();

    if (activeUrl) {
      URL.revokeObjectURL(activeUrl);
      activeUrl = null;
    }
    for (const data of audioCache.values()) {
      URL.revokeObjectURL(data.url);
    }
    audioCache.clear();
    painter?.clear();

    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      try {
        navigator.mediaSession.metadata = null;
      } catch {}
    }
  }

  return {
    play,
    pause,
    seekToOffset,
    skipSentences,
    setRate,
    setVoice,
    prepareEdition,
    subscribe,
    dispose,
    getSnapshot,
  };
}
