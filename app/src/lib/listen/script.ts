// Turns a reflowed reading (lib/reflow) into the text Listen reads aloud,
// joined exactly as TextView shows it, so that every word spoken can be
// mapped back to the page offsets that TextView puts on its runs (data-p,
// data-o) and that the page layout uses for its highlight rectangles.

import type { ListenScript, PagePoint, ScriptPiece, Utterance } from "./types";

/** The parts of lib/reflow's Line and Block that Listen reads. */
export interface ReflowLine {
  page: number;
  start: number;
  text: string;
  hyphen?: boolean;
  glue?: boolean;
}
export interface ReflowBlock {
  kind: string;
  lines: ReflowLine[];
}

/**
 * Longest utterance in characters. An utterance is a whole paragraph when it fits;
 * a longer paragraph is cut into chunks of whole sentences. kokoro-js phonemises
 * each sentence of an utterance separately (TextSplitterStream), and 400
 * characters keeps any one sentence well inside Kokoro's 510-token limit.
 */
export const MAX_UTTERANCE_CHARS = 400;

// Matches TextView's Run (TextView.tsx:17): a line-end hyphen is not shown.
const LINE_END_HYPHEN = /[-\u00ad\u2010\u2011\u2013]\s*$/;

/** The text of a line as TextView shows it. */
export function shownLineText(line: ReflowLine): string {
  return line.hyphen ? line.text.replace(LINE_END_HYPHEN, "") : line.text.replace(/\s+$/, "");
}

/**
 * Flatten blocks into script text. Notes are left out, as TextView leaves them
 * out (TextView.tsx:93). Lines join as TextView joins them (TextView.tsx:106):
 * with a space unless the line ends in a hyphen or is glued to the next.
 * Blocks are separated by "\n", which belongs to no piece.
 */
export function flatten(blocks: ReflowBlock[]): { text: string; pieces: ScriptPiece[]; headings: Array<[number, number]> } {
  let text = "";
  const pieces: ScriptPiece[] = [];
  const headings: Array<[number, number]> = [];
  for (const block of blocks) {
    if (block.kind === "note" || block.kind === "heading" || block.lines.length === 0) continue;
    if (text.length > 0) text += "\n";
    const blockStart = text.length;
    block.lines.forEach((line, i) => {
      const shown = shownLineText(line);
      if (shown.length > 0) {
        pieces.push({ scriptStart: text.length, length: shown.length, page: line.page, pageStart: line.start });
        text += shown;
      }
      const last = i === block.lines.length - 1;
      if (!last && !line.hyphen && !line.glue) text += " ";
    });
    if (block.kind === "heading") headings.push([blockStart, text.length]);
  }
  return { text, pieces, headings };
}

const ABBREVIATIONS = new Set([
  "e.g", "i.e", "cf", "etc", "et al", "al", "vs", "viz", "ibid", "op. cit", "p", "pp", "vol", "vols", "no", "nos",
  "ed", "eds", "trans", "ch", "chap", "fig", "figs", "dr", "mr", "mrs", "ms", "prof", "st", "c", "ca", "approx",
]);

/** Whether a "." at `dot` in `text` ends an abbreviation or an initial rather than a sentence. */
function isAbbreviation(text: string, dot: number): boolean {
  let s = dot - 1;
  while (s >= 0 && /[A-Za-z.]/.test(text[s])) s -= 1;
  const word = text.slice(s + 1, dot).toLowerCase();
  if (/^[a-z]$/i.test(word) && /[A-Z]/.test(text[dot - 1] ?? "")) return true; // an initial, "J."
  if (ABBREVIATIONS.has(word)) return true;
  const two = text.slice(Math.max(0, s - 3), dot).toLowerCase().trim();
  return two.endsWith("et al");
}

/** Sentence ends within [from, to) of `text`, as offsets just after the closing punctuation. */
function sentenceEnds(text: string, from: number, to: number): number[] {
  const ends: number[] = [];
  for (let i = from; i < to; i += 1) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "\u2026") continue;
    let j = i + 1;
    while (j < to && /[.!?\u2026"'\u2019\u201d)\]]/.test(text[j])) j += 1;
    if (j < to && !/\s/.test(text[j])) continue; // "3.5", "e.g.x", a URL
    if (ch === "." && isAbbreviation(text, i)) continue;
    let k = j;
    while (k < to && /\s/.test(text[k])) k += 1;
    if (k < to && /[a-z]/.test(text[k])) continue; // lower case after a full stop: not an end
    ends.push(j);
    i = j - 1;
  }
  return ends;
}

/** Split [start, end) into pieces of at most `max` characters, at a clause mark or a space. */
function splitLong(text: string, start: number, end: number, max: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let s = start;
  while (end - s > max) {
    const window = text.slice(s, s + max);
    let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
    cut = cut > max / 3 ? cut + 1 : window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    out.push([s, s + cut]);
    s += cut;
  }
  out.push([s, end]);
  return out;
}

function trimRange(text: string, start: number, end: number): [number, number] {
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return [start, end];
}

/** The sentences of [from, to) in `text`, trimmed, as [start, end) offsets. */
export function sentenceRanges(text: string, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let s = from;
  for (const e of sentenceEnds(text, from, to)) {
    const [a, b] = trimRange(text, s, e);
    if (b > a) out.push([a, b]);
    s = e;
  }
  const [a, b] = trimRange(text, s, to);
  if (b > a) out.push([a, b]);
  return out;
}

/**
 * Utterances over the whole script: one per paragraph. A paragraph longer than
 * `max` characters is cut into chunks of whole sentences of at most `max`; a
 * single sentence longer than that is cut at a clause mark or a space. Every
 * chunk of one paragraph carries that paragraph's index.
 */
export function splitUtterances(text: string, headings: Array<[number, number]>, max = MAX_UTTERANCE_CHARS): Utterance[] {
  const out: Utterance[] = [];
  let paragraph = 0;
  const push = (a: number, b: number, kind: Utterance["kind"]) => {
    for (const [x, y] of splitLong(text, a, b, max)) {
      const [s, e] = trimRange(text, x, y);
      if (e > s && /[\p{L}\p{N}]/u.test(text.slice(s, e))) {
        out.push({ index: out.length, paragraph, start: s, end: e, text: text.slice(s, e), kind });
      }
    }
  };
  const isHeading = new Set(headings.map(([a]) => a));
  let blockStart = 0;
  while (blockStart <= text.length) {
    let blockEnd = text.indexOf("\n", blockStart);
    if (blockEnd < 0) blockEnd = text.length;
    const [bs, be] = trimRange(text, blockStart, blockEnd);
    const before = out.length;
    if (be > bs) {
      if (isHeading.has(blockStart) || be - bs <= max) {
        push(bs, be, isHeading.has(blockStart) ? "heading" : "body");
      } else {
        let chunk: [number, number] | null = null;
        for (const [a, b] of sentenceRanges(text, bs, be)) {
          if (b - a > max) {
            if (chunk) push(chunk[0], chunk[1], "body");
            chunk = null;
            push(a, b, "body");
          } else if (!chunk) {
            chunk = [a, b];
          } else if (b - chunk[0] <= max) {
            chunk[1] = b;
          } else {
            push(chunk[0], chunk[1], "body");
            chunk = [a, b];
          }
        }
        if (chunk) push(chunk[0], chunk[1], "body");
      }
    }
    if (out.length > before) paragraph += 1;
    blockStart = blockEnd + 1;
  }
  return out;
}

/** The paragraph that utterance `index` belongs to: its first and last utterance and its script range. */
export function paragraphOf(
  utterances: Utterance[],
  index: number,
): { paragraph: number; first: number; last: number; start: number; end: number } | null {
  const u = utterances[index];
  if (!u) return null;
  let first = index;
  let last = index;
  while (first > 0 && utterances[first - 1].paragraph === u.paragraph) first -= 1;
  while (last < utterances.length - 1 && utterances[last + 1].paragraph === u.paragraph) last += 1;
  return { paragraph: u.paragraph, first, last, start: utterances[first].start, end: utterances[last].end };
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const JOINER = /['\u2019-]/;

/** The start of the word at `offset` in `text`, or of the next word when `offset` falls between words. */
export function wordStartAt(text: string, offset: number): number {
  let i = Math.max(0, Math.min(offset, text.length));
  if (i < text.length && WORD_CHAR.test(text[i])) {
    while (i > 0 && (WORD_CHAR.test(text[i - 1]) || (JOINER.test(text[i - 1]) && i > 1 && WORD_CHAR.test(text[i - 2])))) i -= 1;
    return i;
  }
  while (i < text.length && !WORD_CHAR.test(text[i])) i += 1;
  return i;
}

/**
 * The script offset for a tap. A tap on read text maps exactly; a tap that
 * lands between runs (a page number, a gap after a paragraph, a note Listen
 * does not read) maps to the next readable text. Null past the end.
 */
export function pageToScriptNearest(script: Pick<ListenScript, "pieces">, point: PagePoint): number | null {
  const exact = pageToScript(script, point);
  if (exact !== null) return exact;
  let best: number | null = null;
  for (const p of script.pieces) {
    const later = p.page > point.page || (p.page === point.page && p.pageStart + p.length > point.at);
    if (!later) continue;
    const at = p.page === point.page && p.pageStart < point.at ? p.scriptStart + (point.at - p.pageStart) : p.scriptStart;
    if (best === null || at < best) best = at;
  }
  return best;
}

/**
 * The start of the paragraph holding a page point, for the reading place, so a
 * reader who comes back starts at a paragraph rather than mid-sentence. Notes
 * are skipped as TextView skips them; null when the point is in no block.
 */
export function paragraphStartFor(blocks: ReflowBlock[], point: PagePoint): PagePoint | null {
  for (const block of blocks) {
    if (block.kind === "note" || block.lines.length === 0) continue;
    const holds = block.lines.some((l) => l.page === point.page && point.at >= l.start && point.at < l.start + Math.max(1, l.text.length));
    if (holds) return { page: block.lines[0].page, at: block.lines[0].start };
  }
  return null;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildListenScript(blocks: ReflowBlock[]): Promise<ListenScript> {
  const { text, pieces, headings } = flatten(blocks);
  return { hash: await sha256Hex(text), text, pieces, utterances: splitUtterances(text, headings) };
}

/**
 * The page point for a script offset. An offset in a separator (a space
 * between lines or the newline between blocks) maps to the start of the next
 * piece; one past the end maps to the end of the last piece.
 */
export function scriptToPage(script: Pick<ListenScript, "pieces">, offset: number): PagePoint | null {
  const { pieces } = script;
  if (pieces.length === 0) return null;
  let lo = 0;
  let hi = pieces.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pieces[mid].scriptStart <= offset) lo = mid;
    else hi = mid - 1;
  }
  const p = pieces[lo];
  if (offset < p.scriptStart) return { page: p.page, at: p.pageStart };
  if (offset < p.scriptStart + p.length) return { page: p.page, at: p.pageStart + (offset - p.scriptStart) };
  const next = pieces[lo + 1];
  if (next) return { page: next.page, at: next.pageStart };
  return { page: p.page, at: p.pageStart + p.length };
}

/** The script offset for a page point, or null when the point is in no piece (a note, a page number). */
export function pageToScript(script: Pick<ListenScript, "pieces">, point: PagePoint): number | null {
  for (const p of script.pieces) {
    if (p.page === point.page && point.at >= p.pageStart && point.at < p.pageStart + p.length) {
      return p.scriptStart + (point.at - p.pageStart);
    }
  }
  return null;
}

/**
 * The page ranges a script range covers, one per piece it touches, for the
 * highlighter. A word broken over a line or page turn gives two ranges.
 */
export function scriptRangeToPageRanges(
  script: Pick<ListenScript, "pieces">,
  start: number,
  end: number,
): Array<{ page: number; start: number; end: number }> {
  const out: Array<{ page: number; start: number; end: number }> = [];
  for (const p of script.pieces) {
    const a = Math.max(start, p.scriptStart);
    const b = Math.min(end, p.scriptStart + p.length);
    if (b > a) out.push({ page: p.page, start: p.pageStart + (a - p.scriptStart), end: p.pageStart + (b - p.scriptStart) });
    if (p.scriptStart >= end) break;
  }
  return out;
}

/** The utterance containing a script offset, or the next one after it. */
export function utteranceAt(utterances: Utterance[], offset: number): number {
  let lo = 0;
  let hi = utterances.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (utterances[mid].end <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
