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

/** Longest utterance in characters. Kokoro takes at most 510 phonemes per call. */
export const MAX_UTTERANCE_CHARS = 380;

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

/** Utterances over the whole script: one per heading, one per sentence elsewhere. */
export function splitUtterances(text: string, headings: Array<[number, number]>, max = MAX_UTTERANCE_CHARS): Utterance[] {
  const out: Utterance[] = [];
  const push = (a: number, b: number, kind: Utterance["kind"]) => {
    for (const [x, y] of splitLong(text, a, b, max)) {
      const [s, e] = trimRange(text, x, y);
      if (e > s && /[\p{L}\p{N}]/u.test(text.slice(s, e))) out.push({ index: out.length, start: s, end: e, text: text.slice(s, e), kind });
    }
  };
  const isHeading = new Map(headings.map(([a, b]) => [a, b]));
  let blockStart = 0;
  while (blockStart <= text.length) {
    let blockEnd = text.indexOf("\n", blockStart);
    if (blockEnd < 0) blockEnd = text.length;
    if (isHeading.has(blockStart)) {
      push(blockStart, blockEnd, "heading");
    } else {
      let s = blockStart;
      for (const e of sentenceEnds(text, blockStart, blockEnd)) {
        push(s, e, "body");
        s = e;
      }
      push(s, blockEnd, "body");
    }
    blockStart = blockEnd + 1;
  }
  return out;
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
