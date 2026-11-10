// ListenController: orchestrates speech synthesis, audio playback,
// Speechify-style word highlighting, speed control, voice selection,
// and background playback via MediaSession API.
//
// Playback works paragraph by paragraph (script.ts makes one utterance per
// paragraph, or per chunk of a long one). The paragraph being heard is
// synthesised first and plays as soon as it is ready; while it plays, only the
// next paragraph is synthesised, so there is no gap between paragraphs and no
// work is spent on text the reader may never reach.
//
// Invariants:
// - Every playback request takes a new token; any await that returns to an older
//   token stops, so a double tap or a quick second request can never leave the
//   player stuck waiting for audio that was cancelled.
// - A failed or cancelled synthesis never stays in the in-flight map.
// - Cached audio URLs are revoked only when the audio leaves the cache.
// - Speed is the media element's playbackRate with pitch preserved, so a speed
//   change, manual or from the gradual speed up, never needs new audio.

import { alignWords, tokeniseWords } from "./align";
import { type HighlightPainter, type RunIndex, FollowGate, followWordDelta, paragraphTopDelta } from "./highlight";
import { DEFAULT_RAMP, quantiseRate, rampRate } from "./rate";
import {
  pageToScriptNearest,
  paragraphOf,
  scriptRangeToPageRanges,
  scriptToPage,
  sentenceRanges,
  utteranceAt,
  wordStartAt,
} from "./script";
import { browserSpeech, isEngineUnavailable, pickSpeechVoice, type SpeechBackend } from "./speech";
import type {
  EngineId,
  ListenScript,
  PagePoint,
  PlayerState,
  RampSettings,
  TtsEngine,
  WordTiming,
} from "./types";
import { DEFAULT_VOICE } from "./types";
import { pcmToWav } from "./wav";

export interface ListenSnapshot {
  state: PlayerState;
  mode: "stream" | "edition";
  utterance: number;
  word: number;
  /** The speed playing now, the gradual speed up included. */
  rate: number;
  /** The speed the reader chose, which the gradual speed up starts from. */
  baseRate: number;
  ramp: RampSettings;
  voice: string;
  engine: EngineId;
  /** "speech" when Kokoro could not load and the device's own voice is reading. */
  backend: "kokoro" | "speech";
  bufferedSeconds: number;
  error: string | null;
  totalUtterances: number;
  paragraph: number;
  totalParagraphs: number;
  currentPage: number;
}

export interface ListenController {
  /** Resume, start, or (with a point) play from that word. */
  play(from?: PagePoint): Promise<void>;
  /** Tap to play: from the word at a page point, seeking within audio that is already made. */
  playFromPoint(point: PagePoint): Promise<void>;
  pause(): void;
  seekToOffset(scriptOffset: number): void;
  /** Moves by utterance: a paragraph, or a chunk of a long one. */
  skipSentences(n: number): void;
  skipParagraphs(n: number): void;
  setRate(rate: number): void;
  setRamp(ramp: RampSettings): void;
  setVoice(voice: string): Promise<void>;
  prepareEdition(
    maxSeconds: number,
    onProgress: (done: number, total: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /** Where to start next time: the start of the paragraph being heard, or of the one before when it had only just begun. */
  getResumePoint(): PagePoint | null;
  /** Turn following back on at once after the reader scrolled away. */
  followText(): void;
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

/** Less than this far into a paragraph, the resume point is the paragraph before it. */
const RESUME_BACK_SECONDS = 2;

/**
 * Seconds into an utterance's audio where the word holding `offsetInUtterance`
 * starts. At or before the first character it is 0, so a paragraph started from
 * its beginning keeps any lead-in; past the last word it is the last word's start.
 */
export function seekTimeFor(words: WordTiming[], offsetInUtterance: number): number {
  if (offsetInUtterance <= 0 || words.length === 0) return 0;
  const w = words.find((x) => x.end > offsetInUtterance);
  return w ? w.t0 : words[words.length - 1].t0;
}

/** The index of the word being spoken at `t` seconds: the last word started by then, or -1 before the first. */
export function wordIndexAtTime(words: WordTiming[], t: number): number {
  if (words.length === 0 || t < words[0].t0) return -1;
  let lo = 0;
  let hi = words.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (words[mid].t0 <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function isAbort(err: unknown): boolean {
  return (err as Error)?.name === "AbortError";
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
  /** Called when a new paragraph starts, with its first character, for saving the reading place. */
  onParagraphStart?: (point: PagePoint) => void;
  /** The fallback voice; omitted means the browser's speechSynthesis, null means none. */
  speech?: SpeechBackend | null;
  /** Clock in milliseconds, for tests; performance.now by default. */
  now?: () => number;
}): ListenController {
  const { script, engine, title, album, painter, index, scroller, onPageChange, onParagraphStart } = deps;
  const audio = deps.audio ?? new Audio();
  const speech = deps.speech === undefined ? browserSpeech() : deps.speech;
  const now = deps.now ?? (() => performance.now());
  const followGate = new FollowGate();

  let state: PlayerState = "idle";
  let mode: "stream" | "edition" = "stream";
  let backend: "kokoro" | "speech" = "kokoro";
  let currentUtteranceIndex = 0;
  let currentWordIndex = -1;
  let currentParagraph = -1;
  let baseRate = 1.0;
  let ramp: RampSettings = DEFAULT_RAMP;
  let paragraphsDone = 0;
  let playedSeconds = 0;
  let paragraphStartedAt = 0;
  let lastTick: number | null = null;
  let appliedRate = 1.0;
  let voice = DEFAULT_VOICE;
  let errorMsg: string | null = null;
  let token = 0;
  let editionUrl: string | null = null;

  const audioCache = new Map<number, UtteranceAudio>();
  const inFlight = new Map<number, { promise: Promise<UtteranceAudio>; ctrl: AbortController }>();
  const sentenceCache = new Map<number, Array<[number, number]>>();
  const subscribers = new Set<(s: ListenSnapshot) => void>();
  const totalParagraphs = script.utterances.length ? script.utterances[script.utterances.length - 1].paragraph + 1 : 0;

  function rate(): number {
    return rampRate(baseRate, ramp, paragraphsDone, playedSeconds);
  }

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
    let buffered = 0;
    for (const [i, data] of audioCache) if (i > currentUtteranceIndex) buffered += data.duration;
    return {
      state,
      mode,
      utterance: currentUtteranceIndex,
      word: currentWordIndex,
      rate: rate(),
      baseRate,
      ramp,
      voice,
      engine: engine.id,
      backend,
      bufferedSeconds: buffered,
      error: errorMsg,
      totalUtterances: script.utterances.length,
      paragraph: utt ? utt.paragraph : 0,
      totalParagraphs,
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
      navigator.mediaSession.setActionHandler("previoustrack", () => skipParagraphs(-1));
      navigator.mediaSession.setActionHandler("nexttrack", () => skipParagraphs(1));
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

  // The reader's own scrolling pauses following for a few seconds; only real input counts.
  const userScrolled = () => followGate.userScrolled(now());
  if (scroller) {
    scroller.addEventListener("wheel", userScrolled, { passive: true });
    scroller.addEventListener("touchstart", userScrolled, { passive: true });
    scroller.addEventListener("keydown", userScrolled);
  }

  function fetchUtterance(idx: number): Promise<UtteranceAudio> {
    const cached = audioCache.get(idx);
    if (cached) return Promise.resolve(cached);
    const running = inFlight.get(idx);
    if (running) return running.promise;

    const utt = script.utterances[idx];
    if (!utt) return Promise.reject(new Error(`Utterance out of range: ${idx}`));

    const ctrl = new AbortController();
    const requestedVoice = voice;
    const promise = (async () => {
      const result = await engine.synthesise(utt.text, requestedVoice, ctrl.signal);
      const duration = result.pcm.length / result.sampleRate;
      const words = alignWords(utt.text, result.tokens, duration);
      const blob = pcmToWav(result.pcm, result.sampleRate);
      const url = URL.createObjectURL(blob);
      const entry: UtteranceAudio = { url, blob, duration, words, pcm: result.pcm };
      if (requestedVoice === voice && !ctrl.signal.aborted) audioCache.set(idx, entry);
      return entry;
    })();
    const entry = { promise, ctrl };
    inFlight.set(idx, entry);
    // Settled either way, the request leaves the map, so a retry always starts afresh.
    const settle = () => {
      if (inFlight.get(idx) === entry) inFlight.delete(idx);
    };
    promise.then(settle, settle);
    return promise;
  }

  /** Cancel synthesis of anything but the given utterances. */
  function keepOnly(keep: Set<number>): void {
    for (const [idx, entry] of inFlight) {
      if (!keep.has(idx)) {
        entry.ctrl.abort();
        inFlight.delete(idx);
      }
    }
  }

  /** While paragraph N plays, make paragraph N + 1, and nothing further. */
  function prefetchNext(idx: number): void {
    if (mode === "edition" || backend === "speech") return;
    const next = idx + 1;
    if (next < script.utterances.length && !audioCache.has(next) && !inFlight.has(next)) {
      void fetchUtterance(next).catch(() => {});
    }
  }

  function sentencesOf(idx: number): Array<[number, number]> {
    let s = sentenceCache.get(idx);
    if (!s) {
      const utt = script.utterances[idx];
      s = sentenceRanges(script.text, utt.start, utt.end);
      sentenceCache.set(idx, s);
    }
    return s;
  }

  function reducedMotion(): boolean {
    return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  }

  function scrollBy(delta: number): void {
    if (!scroller || Math.abs(delta) < 1) return;
    if (typeof scroller.scrollBy === "function") scroller.scrollBy({ top: delta, behavior: reducedMotion() ? "auto" : "smooth" });
    else scroller.scrollTop += delta;
  }

  function scrollerView(): { top: number; height: number; inset: number } | null {
    if (!scroller) return null;
    const rect = scroller.getBoundingClientRect();
    const inset = typeof getComputedStyle === "function" ? parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0 : 0;
    return { top: rect.top, height: rect.height, inset };
  }

  /** Bring a new paragraph's first line to the top of the view, so the top of the screen is always a paragraph start. */
  function scrollToParagraph(start: number, end: number): void {
    if (!index || !followGate.follows(now())) return;
    const view = scrollerView();
    if (!view) return;
    const range = index.range(scriptRangeToPageRanges(script, start, Math.min(end, start + 24)));
    if (!range) return;
    scrollBy(paragraphTopDelta(range.getBoundingClientRect().top, view, view.inset));
  }

  /** The utterance at `idx` becomes current; a new paragraph is scrolled to and reported. */
  function enterUtterance(idx: number): void {
    currentUtteranceIndex = idx;
    currentWordIndex = -1;
    const utt = script.utterances[idx];
    if (!utt) return;
    if (onPageChange) onPageChange(scriptToPage(script, utt.start)?.page ?? 0);
    const para = paragraphOf(script.utterances, idx);
    if (para && para.paragraph !== currentParagraph) {
      currentParagraph = para.paragraph;
      paragraphStartedAt = playedSeconds;
      scrollToParagraph(para.start, para.end);
      const point = scriptToPage(script, para.start);
      if (point && onParagraphStart) onParagraphStart(point);
    }
  }

  /** Paint a word (script offsets) and the sentence around it, and follow it when it leaves the view. */
  function showWord(idx: number, start: number, end: number): void {
    if (!painter || !index) return;
    const sentence = sentencesOf(idx).find(([a, b]) => start >= a && start < b) ?? [start, end];
    const wordRange = index.range(scriptRangeToPageRanges(script, start, end));
    painter.show("word", wordRange);
    painter.show("sentence", index.range(scriptRangeToPageRanges(script, sentence[0], sentence[1])));
    if (wordRange && followGate.follows(now())) {
      const view = scrollerView();
      if (view) {
        const rect = wordRange.getBoundingClientRect();
        scrollBy(followWordDelta({ top: rect.top, bottom: rect.bottom }, view, view.inset));
      }
    }
  }

  /** Count listening time while playing, for the per-minute speed up and the resume point. */
  function tick(): void {
    const t = now();
    if (lastTick !== null && state === "playing") playedSeconds += Math.min(1, Math.max(0, (t - lastTick) / 1000));
    lastTick = state === "playing" ? t : null;
  }

  /** Put the current speed, gradual speed up included, on the media element. */
  function applyRate(): void {
    const r = rate();
    if (Math.abs(r - appliedRate) < 1e-9) return;
    appliedRate = r;
    audio.playbackRate = r;
    audio.defaultPlaybackRate = r;
    emit();
  }

  function seekWhenReady(t: number): Promise<void> {
    if (t <= 0) return Promise.resolve();
    if (audio.readyState >= 1) {
      audio.currentTime = t;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const done = () => {
        audio.removeEventListener("loadedmetadata", done);
        clearTimeout(timer);
        audio.currentTime = t;
        resolve();
      };
      const timer = setTimeout(done, 3000);
      audio.addEventListener("loadedmetadata", done);
    });
  }

  async function startAudio(data: UtteranceAudio, t: number): Promise<void> {
    if (audio.src !== data.url) audio.src = data.url;
    appliedRate = rate();
    audio.playbackRate = appliedRate;
    audio.defaultPlaybackRate = appliedRate;
    audio.preservesPitch = true;
    await seekWhenReady(t);
    await audio.play();
  }

  function switchToSpeech(err: unknown): void {
    backend = "speech";
    const reason = (err as Error)?.message ?? "Kokoro could not load";
    errorMsg = `Kokoro is unavailable, so your device's voice is reading instead (${reason}).`;
    keepOnly(new Set());
  }

  /** The device's voice reads utterance `idx` from script offset `from`, sentence by sentence. */
  function speakFrom(idx: number, from: number, my: number): void {
    if (!speech) return;
    speech.synth.cancel();
    // Chrome and Safari keep speechSynthesis paused through cancel(), so after a
    // pause every new utterance would wait silently and a tap on a word would
    // seem to do nothing. Resuming an empty queue is harmless everywhere.
    speech.synth.resume();
    enterUtterance(idx);
    const utt = script.utterances[idx];
    // Chrome stops a long utterance after about fifteen seconds, so each sentence is its own.
    const sentences = sentencesOf(idx)
      .filter(([, b]) => b > from)
      .map(([a, b]): [number, number] => [Math.max(a, from), b]);
    if (sentences.length === 0) {
      utteranceFinished(idx, my);
      return;
    }
    const speechVoice = pickSpeechVoice(speech.synth.getVoices());
    const words = tokeniseWords(utt.text);
    sentences.forEach(([a, b], k) => {
      const u = speech.make(script.text.slice(a, b));
      u.rate = rate();
      u.lang = speechVoice?.lang ?? "en-GB";
      u.voice = speechVoice;
      u.onboundary = (e) => {
        if (my !== token || (e.name && e.name !== "word")) return;
        tick();
        const at = a + e.charIndex - utt.start;
        const w = words.findIndex((x) => x.end > at);
        if (w >= 0 && w !== currentWordIndex) {
          currentWordIndex = w;
          showWord(idx, utt.start + words[w].start, utt.start + words[w].end);
          emit();
        }
      };
      u.onerror = (e) => {
        if (my !== token || e.error === "interrupted" || e.error === "canceled") return;
        errorMsg = `The device's voice failed (${e.error ?? "unknown error"}).`;
        if (k === sentences.length - 1) utteranceFinished(idx, my);
      };
      if (k === sentences.length - 1) u.onend = () => utteranceFinished(idx, my);
      speech.synth.speak(u);
    });
    state = "playing";
    lastTick = now();
    emit();
  }

  /** An utterance ended: count a finished paragraph for the speed up, then go on. */
  function utteranceFinished(idx: number, my: number): void {
    if (my !== token) return;
    tick();
    const para = paragraphOf(script.utterances, idx);
    if (para && para.last === idx) {
      paragraphsDone += 1;
      applyRate();
    }
    if (idx + 1 < script.utterances.length) {
      void playUtterance(idx + 1);
    } else {
      state = "ended";
      painter?.clear();
      emit();
    }
  }

  /** Play utterance `idx`, from the word at script offset `startOffset` when given. */
  async function playUtterance(idx: number, startOffset: number | null = null): Promise<void> {
    const my = ++token;
    if (idx >= script.utterances.length) {
      state = "ended";
      painter?.clear();
      emit();
      return;
    }
    const utt = script.utterances[idx];
    const from = startOffset ?? utt.start;
    if (mode === "edition") leaveEdition();

    if (backend === "speech") {
      speakFrom(idx, from, my);
      return;
    }

    enterUtterance(idx);
    keepOnly(new Set([idx, idx + 1]));
    const cached = audioCache.get(idx);
    if (!cached) {
      state = "buffering";
      emit();
    }

    try {
      const data = cached ?? (await fetchUtterance(idx));
      if (my !== token) return;
      await startAudio(data, seekTimeFor(data.words, from - utt.start));
      if (my !== token) return;
      state = "playing";
      lastTick = now();
      emit();
      prefetchNext(idx);
    } catch (err: unknown) {
      if (my !== token || isAbort(err)) return;
      if (isEngineUnavailable(err) && speech) {
        switchToSpeech(err);
        speakFrom(idx, from, my);
        return;
      }
      console.error("Playback error:", err);
      errorMsg = (err as Error)?.message ?? "Audio playback failed";
      if (isEngineUnavailable(err)) {
        state = "error";
        emit();
        return;
      }
      // One paragraph that failed is skipped; the rest still plays.
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
    if (mode === "edition" || backend === "speech") return;
    tick();
    if (ramp.enabled && ramp.every === "minute") applyRate();
    const uttAudio = audioCache.get(currentUtteranceIndex);
    const utt = script.utterances[currentUtteranceIndex];
    if (!uttAudio || !utt || audio.src !== uttAudio.url) return;
    const wordIdx = wordIndexAtTime(uttAudio.words, audio.currentTime);
    if (wordIdx !== currentWordIndex && wordIdx >= 0) {
      currentWordIndex = wordIdx;
      const w = uttAudio.words[wordIdx];
      showWord(currentUtteranceIndex, utt.start + w.start, utt.start + w.end);
      emit();
    }
  };

  audio.onended = () => {
    if (mode === "stream") {
      utteranceFinished(currentUtteranceIndex, token);
    } else {
      state = "ended";
      painter?.clear();
      emit();
    }
  };

  audio.onpause = () => {
    // A media element fires pause just before ended; that is not the reader pausing.
    if (state === "playing" && !audio.ended) {
      state = "paused";
      lastTick = null;
      emit();
    }
  };

  audio.onplay = () => {
    if (state === "paused") {
      state = "playing";
      lastTick = now();
      emit();
    }
  };

  async function playFromPoint(point: PagePoint): Promise<void> {
    setupMediaSession();
    const raw = pageToScriptNearest(script, point);
    if (raw === null) return;
    const offset = wordStartAt(script.text, raw);
    const idx = utteranceAt(script.utterances, offset);
    if (idx < 0 || idx >= script.utterances.length) return;
    followGate.resume();

    const cached = audioCache.get(idx);
    if (backend === "kokoro" && mode === "stream" && idx === currentUtteranceIndex && cached && audio.src === cached.url) {
      // The paragraph is already loaded: seek within it, without reloading the audio.
      token += 1;
      audio.currentTime = seekTimeFor(cached.words, offset - script.utterances[idx].start);
      if (audio.paused) await audio.play();
      state = "playing";
      lastTick = now();
      emit();
      prefetchNext(idx);
      return;
    }
    await playUtterance(idx, offset);
  }

  async function play(from?: PagePoint): Promise<void> {
    setupMediaSession();
    if (from) return playFromPoint(from);

    if (state === "paused") {
      if (backend === "speech" && speech) {
        speech.synth.resume();
        state = "playing";
        lastTick = now();
        emit();
        return;
      }
      if (audio.src) {
        await audio.play();
        state = "playing";
        lastTick = now();
        emit();
        return;
      }
    }
    // Already starting or playing: a second press, or a double click, changes nothing.
    if (state === "playing" || state === "buffering" || state === "preparing") return;

    await playUtterance(state === "ended" ? 0 : currentUtteranceIndex);
  }

  function pause(): void {
    tick();
    if (backend === "speech" && speech) speech.synth.pause();
    else audio.pause();
    state = "paused";
    lastTick = null;
    emit();
  }

  function seekToOffset(scriptOffset: number): void {
    const uIdx = utteranceAt(script.utterances, scriptOffset);
    if (uIdx >= 0) {
      void playUtterance(uIdx, wordStartAt(script.text, scriptOffset));
    }
  }

  function skipSentences(n: number): void {
    const nextIdx = Math.max(0, Math.min(script.utterances.length - 1, currentUtteranceIndex + n));
    void playUtterance(nextIdx);
  }

  function skipParagraphs(n: number): void {
    const utt = script.utterances[currentUtteranceIndex];
    if (!utt) return;
    const target = Math.max(0, Math.min(totalParagraphs - 1, utt.paragraph + n));
    const idx = script.utterances.findIndex((u) => u.paragraph === target);
    if (idx >= 0) void playUtterance(idx);
  }

  /** Restart the device's voice at the word being read, so a new speed or voice takes effect at once. */
  function restartSpeech(): void {
    if (backend !== "speech" || state !== "playing") return;
    const utt = script.utterances[currentUtteranceIndex];
    if (!utt) return;
    const words = tokeniseWords(utt.text);
    const w = words[currentWordIndex];
    void playUtterance(currentUtteranceIndex, w ? utt.start + w.start : utt.start);
  }

  function setRate(newRate: number): void {
    baseRate = quantiseRate(newRate);
    // The gradual speed up starts again from the speed just chosen.
    paragraphsDone = 0;
    playedSeconds = 0;
    appliedRate = Number.NaN;
    applyRate();
    audio.preservesPitch = true;
    restartSpeech();
  }

  function setRamp(next: RampSettings): void {
    ramp = { ...next };
    paragraphsDone = 0;
    playedSeconds = 0;
    appliedRate = Number.NaN;
    applyRate();
  }

  async function setVoice(newVoice: string): Promise<void> {
    if (voice === newVoice) return;
    voice = newVoice;
    // Audio in the old voice is dropped, except the paragraph playing now, which finishes as it is.
    keepOnly(new Set());
    for (const [idx, data] of audioCache.entries()) {
      if (idx !== currentUtteranceIndex) {
        URL.revokeObjectURL(data.url);
        audioCache.delete(idx);
      }
    }
    if (state === "playing" && backend === "kokoro") prefetchNext(currentUtteranceIndex);
    restartSpeech();
    emit();
  }

  function leaveEdition(): void {
    mode = "stream";
    if (editionUrl) {
      URL.revokeObjectURL(editionUrl);
      editionUrl = null;
    }
  }

  async function prepareEdition(
    maxSeconds: number,
    onProgress: (done: number, total: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (backend === "speech") throw new Error("Offline listening needs Kokoro, which could not load.");
    pause();
    token += 1;
    mode = "edition";
    state = "preparing";
    emit();

    const parts: Float32Array[] = [];
    let accumulatedSeconds = 0;
    const startIndex = currentUtteranceIndex;
    const endIndex = script.utterances.length;

    for (let i = startIndex; i < endIndex; i += 1) {
      if (signal.aborted) break;
      const utt = await fetchUtterance(i);
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

    if (editionUrl) URL.revokeObjectURL(editionUrl);
    editionUrl = URL.createObjectURL(pcmToWav(merged, 24000));
    audio.src = editionUrl;
    audio.playbackRate = rate();
    audio.preservesPitch = true;

    state = "paused";
    emit();
  }

  function getResumePoint(): PagePoint | null {
    const para = paragraphOf(script.utterances, currentUtteranceIndex);
    if (!para) return null;
    let start = para.start;
    if (playedSeconds - paragraphStartedAt < RESUME_BACK_SECONDS && para.first > 0) {
      const before = paragraphOf(script.utterances, para.first - 1);
      if (before) start = before.start;
    }
    return scriptToPage(script, start);
  }

  function followText(): void {
    followGate.resume();
  }

  function subscribe(listener: (s: ListenSnapshot) => void): () => void {
    subscribers.add(listener);
    listener(getSnapshot());
    return () => {
      subscribers.delete(listener);
    };
  }

  function dispose(): void {
    token += 1;
    subscribers.clear();
    audio.pause();
    audio.ontimeupdate = null;
    audio.onended = null;
    audio.onpause = null;
    audio.onplay = null;
    keepOnly(new Set());
    speech?.synth.cancel();
    if (scroller) {
      scroller.removeEventListener("wheel", userScrolled);
      scroller.removeEventListener("touchstart", userScrolled);
      scroller.removeEventListener("keydown", userScrolled);
    }

    leaveEdition();
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
    playFromPoint,
    pause,
    seekToOffset,
    skipSentences,
    skipParagraphs,
    setRate,
    setRamp,
    setVoice,
    prepareEdition,
    getResumePoint,
    followText,
    subscribe,
    dispose,
    getSnapshot,
  };
}
