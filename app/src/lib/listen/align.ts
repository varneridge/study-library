// Word timing. Engines report timed tokens: the local Python engine gives
// misaki tokens with their source text (MToken.text, start_ts, end_ts), and
// the browser engine gives phoneme-word spans without text, derived from the
// timestamped ONNX model's durations. Both are aligned here to the words of
// the utterance as the reader shows them, so highlighting never depends on
// how an engine normalised "1984" or "e.g." before speaking it.

import type { PlaybackTimeline, SourceWord, TimedToken, TimelineWord, WordTiming } from "./types";

const WORD = /[\p{L}\p{N}](?:[\p{L}\p{N}\u2019'\-]*[\p{L}\p{N}])?/gu;

export function normalise(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** Relative spoken length: digits are read as number words, so they weigh more. */
export function spokenWeight(word: string): number {
  let w = 1;
  for (const ch of word) {
    if (/\p{N}/u.test(ch)) w += 3;
    else if (/\p{L}/u.test(ch)) w += 1;
  }
  return w;
}

export function tokeniseWords(text: string): SourceWord[] {
  const out: SourceWord[] = [];
  for (const m of text.matchAll(WORD)) {
    const start = m.index ?? 0;
    out.push({ start, end: start + m[0].length, norm: normalise(m[0]), weight: spokenWeight(m[0]) });
  }
  return out;
}

interface Anchor {
  word: number;
  t0: number;
  t1: number;
}

/** Spread words [from, to) over [a, b] seconds in proportion to their weights. */
function spread(words: SourceWord[], from: number, to: number, a: number, b: number, out: WordTiming[]): void {
  const total = words.slice(from, to).reduce((s, w) => s + w.weight, 0);
  if (total <= 0) return;
  let t = a;
  const span = Math.max(0, b - a);
  for (let i = from; i < to; i += 1) {
    const d = (span * words[i].weight) / total;
    out[i] = { start: words[i].start, end: words[i].end, t0: t, t1: t + d, source: "interpolated" };
    t += d;
  }
}

/** Fill every word that has no timing by spreading it between its timed neighbours. */
function fillGaps(words: SourceWord[], anchors: Anchor[], duration: number): WordTiming[] {
  const out: WordTiming[] = new Array(words.length);
  for (const a of anchors) out[a.word] = { start: words[a.word].start, end: words[a.word].end, t0: a.t0, t1: a.t1, source: "engine" };
  let prevEnd = 0;
  let i = 0;
  while (i < words.length) {
    if (out[i]) {
      prevEnd = out[i].t1;
      i += 1;
      continue;
    }
    let j = i;
    while (j < words.length && !out[j]) j += 1;
    const nextStart = j < words.length ? out[j].t0 : duration;
    spread(words, i, j, prevEnd, Math.max(prevEnd, nextStart), out);
    i = j;
  }
  return out;
}

/** Make timings monotonic, non-overlapping and inside [0, duration]. */
export function tidy(timings: WordTiming[], duration: number): WordTiming[] {
  let floor = 0;
  return timings.map((w, i) => {
    const t0 = Math.min(duration, Math.max(floor, w.t0));
    const nextT0 = i + 1 < timings.length ? timings[i + 1].t0 : duration;
    const t1 = Math.min(duration, Math.max(t0, Math.min(w.t1, Math.max(t0, nextT0))));
    floor = t1;
    return { ...w, t0, t1 };
  });
}

const LOOKAHEAD = 6;

/** Align words to tokens that carry their source text (the local engine). */
function alignTexted(words: SourceWord[], tokens: TimedToken[]): Anchor[] {
  const toks = tokens.map((t) => ({ ...t, norm: normalise(t.text ?? "") })).filter((t) => t.norm.length > 0);
  const anchors: Anchor[] = [];
  let i = 0;
  let j = 0;
  while (i < words.length && j < toks.length) {
    const w = words[i].norm;
    const t = toks[j].norm;
    if (w === t) {
      anchors.push({ word: i, t0: toks[j].start, t1: toks[j].end });
      i += 1;
      j += 1;
      continue;
    }
    // One word, several tokens ("well-known" read as "well" "known").
    if (w.startsWith(t)) {
      let acc = t;
      let k = j + 1;
      while (k < toks.length && w.startsWith(acc + toks[k].norm) && acc.length < w.length) acc += toks[k++].norm;
      if (acc === w) {
        anchors.push({ word: i, t0: toks[j].start, t1: toks[k - 1].end });
        i += 1;
        j = k;
        continue;
      }
    }
    // One token, several words ("1,000" read as one token, shown as "1" "000").
    if (t.startsWith(w)) {
      let acc = w;
      let k = i + 1;
      while (k < words.length && t.startsWith(acc + words[k].norm) && acc.length < t.length) acc += words[k++].norm;
      if (acc === t) {
        const n = k - i;
        const d = (toks[j].end - toks[j].start) / n;
        for (let m = 0; m < n; m += 1) anchors.push({ word: i + m, t0: toks[j].start + m * d, t1: toks[j].start + (m + 1) * d });
        i = k;
        j += 1;
        continue;
      }
    }
    // Out of step: look a few words and tokens ahead for the nearest exact match.
    let best: [number, number] | null = null;
    for (let di = 0; di <= LOOKAHEAD && !best; di += 1) {
      for (let dj = 0; dj <= LOOKAHEAD; dj += 1) {
        if (di === 0 && dj === 0) continue;
        if (i + di < words.length && j + dj < toks.length && words[i + di].norm === toks[j + dj].norm) {
          best = [i + di, j + dj];
          break;
        }
      }
    }
    if (!best) {
      // Nothing near matches: this token was a normalised form (a number read
      // as words, a symbol); drop it and let the word be interpolated.
      j += 1;
      continue;
    }
    [i, j] = best;
  }
  return anchors;
}

/** Align words to untexted spans (the browser engine's phoneme words). */
function alignUntexted(words: SourceWord[], spans: TimedToken[]): Anchor[] {
  if (spans.length === words.length) return words.map((_, i) => ({ word: i, t0: spans[i].start, t1: spans[i].end }));
  // Different counts: map cumulative word weight onto cumulative spoken time,
  // measured over spans only, so pauses between spans stay pauses.
  const spoken = spans.reduce((s, x) => s + Math.max(0, x.end - x.start), 0);
  const total = words.reduce((s, w) => s + w.weight, 0);
  if (spoken <= 0 || total <= 0) return [];
  const timeAt = (fraction: number): number => {
    let left = fraction * spoken;
    for (const s of spans) {
      const d = Math.max(0, s.end - s.start);
      if (left <= d) return s.start + left;
      left -= d;
    }
    return spans[spans.length - 1].end;
  };
  let acc = 0;
  return words.map((w, i) => {
    const t0 = timeAt(acc / total);
    acc += w.weight;
    return { word: i, t0, t1: timeAt(acc / total) };
  });
}

/**
 * Word timings for one utterance. `tokens` are in seconds from the start of
 * the utterance's audio, `duration` is that audio's length in seconds.
 */
export function alignWords(text: string, tokens: TimedToken[], duration: number): WordTiming[] {
  const words = tokeniseWords(text);
  if (words.length === 0) return [];
  const usable = tokens.filter((t) => Number.isFinite(t.start) && Number.isFinite(t.end) && t.end >= t.start);
  const texted = usable.some((t) => t.text !== null);
  const anchors = usable.length === 0 ? [] : texted ? alignTexted(words, usable) : alignUntexted(words, usable);
  return tidy(fillGaps(words, anchors, duration), duration);
}

/**
 * The continuous timeline over rendered utterances. `offsetSeconds` is the
 * constant delay a decoder adds before the first sample of each encoded
 * utterance (MP3 encoder priming), measured once per encoder setting.
 */
export function buildTimeline(
  rendered: Array<{ utterance: number; scriptStart: number; samples: number; sampleRate: number; words: WordTiming[] }>,
  offsetSeconds = 0,
): PlaybackTimeline {
  const utteranceStarts: number[] = [];
  const words: TimelineWord[] = [];
  let t = 0;
  for (const r of rendered) {
    utteranceStarts.push(t);
    for (const w of r.words) {
      words.push({ utterance: r.utterance, start: r.scriptStart + w.start, end: r.scriptStart + w.end, t0: t + offsetSeconds + w.t0, t1: t + offsetSeconds + w.t1 });
    }
    t += r.samples / r.sampleRate;
  }
  return { utteranceStarts, words, duration: t };
}

/**
 * The index of the word being spoken at media time `t`, or -1 before the
 * first word. Between two words (a pause) the earlier word stays lit, as
 * Speechify does, so the highlight never flickers off mid-sentence.
 */
export function wordIndexAt(words: TimelineWord[], t: number): number {
  let lo = 0;
  let hi = words.length - 1;
  if (hi < 0 || t < words[0].t0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (words[mid].t0 <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The media time to seek to so that playback starts at the word holding script offset `offset`. */
export function timeForOffset(words: TimelineWord[], offset: number): number | null {
  for (const w of words) if (w.end > offset) return w.t0;
  return null;
}
