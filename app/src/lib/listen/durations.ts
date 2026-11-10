// Word spans from Kokoro's predicted durations, for the browser engine.
//
// Kokoro predicts how many frames each input token lasts. kokoro-js feeds the
// model one token per phoneme character, wrapped in a start and an end token
// (its tokenizer adds both), so durations[k + 1] belongs to phonemes[k]. A word
// in the phoneme string is a run of characters between spaces and punctuation;
// its span runs from the time its first character starts to the time its last
// one ends. Seconds per frame are measured from the audio itself (total audio
// seconds over total frames), so the result does not depend on the model's
// hop size being 600 samples (Kokoro's 40 frames a second at 24 kHz).

import { tokeniseWords } from "./align";
import type { TimedToken } from "./types";

/** Characters that separate phoneme words. kokoro-js keeps punctuation as-is in the phoneme string. */
const SEPARATOR = /[\s;:,.!?\u00a1\u00bf\u2014\u2026"\u00ab\u00bb\u201c\u201d(){}[\]]/u;

/**
 * Untexted word spans (text: null) in seconds from the start of the audio, or
 * an empty list when the durations do not line up with the phonemes (the
 * tokenizer dropped a character it has no id for), so the caller falls back to
 * interpolation instead of highlighting the wrong words.
 */
export function spansFromDurations(phonemes: string, durations: ArrayLike<number>, audioSeconds: number): TimedToken[] {
  const chars = [...phonemes];
  if (durations.length !== chars.length + 2 || !(audioSeconds > 0)) return [];
  let frames = 0;
  for (let i = 0; i < durations.length; i += 1) {
    const d = Number(durations[i]);
    if (!Number.isFinite(d) || d < 0) return [];
    frames += d;
  }
  if (frames <= 0) return [];
  const perFrame = audioSeconds / frames;
  const spans: TimedToken[] = [];
  let t = Number(durations[0]) * perFrame;
  let open: number | null = null;
  for (let k = 0; k < chars.length; k += 1) {
    const d = Number(durations[k + 1]) * perFrame;
    if (SEPARATOR.test(chars[k])) {
      if (open !== null) {
        spans.push({ text: null, start: open, end: t });
        open = null;
      }
    } else if (open === null) {
      open = t;
    }
    t += d;
  }
  if (open !== null) spans.push({ text: null, start: open, end: t });
  return spans;
}

/** Spans of several chunks of one utterance (kokoro-js splits long text) on one timeline. */
export function joinChunkSpans(chunks: Array<{ spans: TimedToken[]; seconds: number }>): TimedToken[] {
  const out: TimedToken[] = [];
  let offset = 0;
  for (const c of chunks) {
    for (const s of c.spans) out.push({ text: s.text, start: s.start + offset, end: s.end + offset });
    offset += c.seconds;
  }
  return out;
}

/**
 * Texted word tokens for an utterance whose model gave no durations. kokoro-js
 * synthesises each sentence of the text as its own chunk and reports its text
 * and audio length, so words are spread over their own sentence's audio rather
 * than over the whole paragraph. A word's timing error is then bounded by one
 * sentence, however long the paragraph.
 */
export function chunkTokens(chunks: Array<{ text: string; seconds: number }>): TimedToken[] {
  const out: TimedToken[] = [];
  let offset = 0;
  for (const c of chunks) {
    const words = tokeniseWords(c.text);
    const total = words.reduce((s, w) => s + w.weight, 0);
    let t = offset;
    for (const w of words) {
      const d = total > 0 ? (c.seconds * w.weight) / total : 0;
      out.push({ text: c.text.slice(w.start, w.end), start: t, end: t + d });
      t += d;
    }
    offset += c.seconds;
  }
  return out;
}
