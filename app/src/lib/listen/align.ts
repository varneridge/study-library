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

/** The shortest word that may anchor the written to the spoken words: shorter ones repeat too often to be trusted. */
const ANCHOR_MIN_LETTERS = 3;

/** The longest ordered run of written words that are spoken as themselves, as [written, spoken] index pairs. */
function matchAnchors(written: SourceWord[], spoken: SourceWord[]): Array<[number, number]> {
  const n = written.length;
  const m = spoken.length;
  const width = m + 1;
  const same = (i: number, j: number) => written[i].norm.length >= ANCHOR_MIN_LETTERS && written[i].norm === spoken[j].norm;
  // table[i * width + j] is the longest run in written[i..] against spoken[j..].
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = same(i, j) ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(i, j)) {
      out.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i += 1;
    else j += 1;
  }
  return out;
}

/**
 * Give the written words [a, b) the spoken words [c, d) in proportion to their
 * spoken length. Every written word gets at least one spoken word, so when
 * there are more written words than spoken ones some share a spoken word.
 * Only when no spoken word is left does a written word get an empty range.
 */
function mapBlock(written: SourceWord[], spoken: SourceWord[], a: number, b: number, c: number, d: number, out: Array<[number, number]>): void {
  const n = b - a;
  const m = d - c;
  if (n <= 0) return;
  if (m <= 0) {
    for (let i = a; i < b; i += 1) out[i] = [c, c];
    return;
  }
  const cumulative = [0];
  for (let k = c; k < d; k += 1) cumulative.push(cumulative[cumulative.length - 1] + spoken[k].weight);
  let total = 0;
  for (let i = a; i < b; i += 1) total += written[i].weight;
  // bounds[k] is the spoken word, counted from c, where written word k begins.
  const bounds = [0];
  let heard = 0;
  let at = 0;
  for (let k = 1; k < n; k += 1) {
    heard += written[a + k - 1].weight;
    const target = (heard / total) * cumulative[m];
    while (at < m && Math.abs(cumulative[at + 1] - target) <= Math.abs(cumulative[at] - target)) at += 1;
    // With spoken words to spare, each written word keeps a word of its own.
    bounds.push(n <= m ? Math.max(bounds[k - 1] + 1, Math.min(at, m - (n - k))) : at);
  }
  bounds.push(m);
  for (let k = 0; k < n; k += 1) {
    const first = Math.min(bounds[k], m - 1);
    out[a + k] = [c + first, c + Math.max(first + 1, bounds[k + 1])];
  }
}

/**
 * For each written word, the spoken words [first, end) that say it. Words
 * spoken as themselves anchor the mapping, in order and only when they have
 * three letters or more. What lies between two anchors ("c. 1945" read as
 * "circa nineteen forty-five") is spread over the spoken words between them by
 * length. With no anchors at all the whole text is one such stretch.
 */
export function mapWords(written: SourceWord[], spoken: SourceWord[]): Array<[number, number]> {
  const out: Array<[number, number]> = new Array(written.length);
  let w = 0;
  let s = 0;
  for (const [i, j] of matchAnchors(written, spoken)) {
    mapBlock(written, spoken, w, i, s, j, out);
    out[i] = [j, j + 1];
    w = i + 1;
    s = j + 1;
  }
  mapBlock(written, spoken, w, written.length, s, spoken.length, out);
  return out;
}

/**
 * Word timings for one utterance. `tokens` are in seconds from the start of
 * the utterance's audio, `duration` is that audio's length in seconds. `spoken`
 * is the plain text the engine actually read when that differs from `text`
 * ("1954" written out as "nineteen fifty-four"): the tokens are then aligned to
 * the spoken words, and each written word takes the span of the spoken words
 * that say it.
 */
export function alignWords(text: string, tokens: TimedToken[], duration: number, spoken?: string): WordTiming[] {
  const words = tokeniseWords(text);
  if (words.length === 0) return [];
  const usable = tokens.filter((t) => Number.isFinite(t.start) && Number.isFinite(t.end) && t.end >= t.start);
  const texted = usable.some((t) => t.text !== null);
  const spokenWords = spoken && spoken !== text ? tokeniseWords(spoken) : [];
  if (spokenWords.length === 0) {
    const anchors = usable.length === 0 ? [] : texted ? alignTexted(words, usable) : alignUntexted(words, usable);
    return tidy(fillGaps(words, anchors, duration), duration);
  }
  const spokenAnchors = usable.length === 0 ? [] : texted ? alignTexted(spokenWords, usable) : alignUntexted(spokenWords, usable);
  const heard = fillGaps(spokenWords, spokenAnchors, duration);
  const engine = new Set(spokenAnchors.map((a) => a.word));
  const mapped = mapWords(words, spokenWords);
  const anchors: Anchor[] = [];
  const fromEngine = new Set<number>();
  mapped.forEach(([first, end], i) => {
    if (end <= first) return; // nothing was said for it: it is timed from its neighbours
    let t0 = Infinity;
    let t1 = -Infinity;
    let all = true;
    for (let k = first; k < end; k += 1) {
      t0 = Math.min(t0, heard[k].t0);
      t1 = Math.max(t1, heard[k].t1);
      if (!engine.has(k)) all = false;
    }
    anchors.push({ word: i, t0, t1 });
    if (all) fromEngine.add(i);
  });
  const timed = fillGaps(words, anchors, duration).map((w, i): WordTiming => ({ ...w, source: fromEngine.has(i) ? "engine" : "interpolated" }));
  return tidy(timed, duration);
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
