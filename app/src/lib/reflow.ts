// Turning PDF pages into text that reflows to fit a phone: headings,
// paragraphs and notes, with the page numbers kept so citations still work.
//
// pdf.js gives positioned pieces of text. These are gathered into lines,
// running heads and page numbers are dropped, two-column pages are read
// column by column, and lines are joined into paragraphs where the spacing,
// indentation and punctuation say a paragraph goes on. Every piece keeps its
// place on the page, so highlights made in either view show in both.

import type { PDFDocumentProxy } from "pdfjs-dist";

export interface Piece { start: number; end: number; rect: [number, number, number, number] }
export interface Line {
  page: number; start: number; end: number; text: string; hyphen: boolean; x0: number; x1: number; y: number; size: number;
  // The last word runs on into the next line with no hyphen to show it, as
  // in an OCR layer that dropped the hyphen: "histori" and "ans".
  glue?: boolean;
  // Part of a box set beside the text, such as an article's Keywords.
  aside?: boolean;
  // The left and right edges of the column the line sits in.
  colLeft: number; colRight: number;
}
export interface Block { kind: "heading" | "para" | "note"; lines: Line[] }
export interface PageText { page: number; text: string; pieces: Piece[]; height: number }
export interface Reflowed { blocks: Block[]; pages: PageText[]; words: number; usable: boolean }

interface RawPart { text: string; x: number; w: number; h: number; y: number; cap?: boolean }
interface RawLine { y: number; size: number; x0: number; x1: number; parts: RawPart[]; colLeft?: number; colRight?: number; top?: number; bottom?: number; aside?: boolean }

// Lines a database or publisher adds to every download: JSTOR's footer and
// cover, Taylor & Francis's contact line and copyright, and bare links.
const JUNK = /^(this content downloaded from|all use subject to|jstor is a not-for-profit|your use of the jstor archive|stable url:|contact\s+\S+.*@\S+|\u00a9\s?\d{4}\b.{0,60}$|to cite this article:|published online:|submit your article|view related articles|view crossmark|full terms & conditions|https?:\/\/\S+$)/i;
const PUBLISHER_FOOTER = /(?:created from lse on|downloaded from https?:\/\/|cambridge core|oxford scholarship online|proquest ebook central|terms of use|all rights reserved\.? may not be reproduced|all use subject to https?:\/\/)/i;

const HYPHEN_END = /[a-z\u00e0-\u024f][-\u00ad\u2010\u2011\u2013]$/i;
const ABBREV = /\b(?:[A-Z]\.|[A-Z][a-z]{1,4}\.|e\.g\.|i\.e\.|cf\.|viz\.|al\.|etc\.|vs\.|vols?\.|nos?\.|pp?\.|\bsec\.|eds?\.|figs?\.)[)'"\u201d\u2019\]]*$/;
const LIST_ITEM = /^(?:(?:\d{1,2}|[a-z]|[ivx]{1,4})[.)]\s+|[•\u2022\u2023\u25e6\u2043\u2219-]\s+)/i;

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
}

async function readPage(doc: PDFDocumentProxy, index: number): Promise<{ lines: RawLine[]; width: number; height: number; ocr: boolean }> {
  const page = await doc.getPage(index + 1);
  const view = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const parts = content.items
    .filter((it): it is Extract<typeof it, { str: string }> => "str" in it && it.str.trim() !== "")
    .filter((it) => Math.abs(it.transform[1]) <= 0.05 && Math.abs(it.transform[2]) <= 0.05)
    .map((it) => ({ text: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.hypot(it.transform[2], it.transform[3]) || it.height || 10 }));
  parts.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: RawLine[] = [];
  const typical = median(parts.map((p) => p.h)) || 10;
  // An OCR text layer, as on a JSTOR scan, comes a word at a time, each with
  // its own baseline and a guessed size. Its lines are found by words that
  // overlap in height, not by baselines that match exactly.
  const ocr = parts.length > 60 && parts.filter((p) => !/\s/.test(p.text.trim())).length / parts.length > 0.75;
  // The widest gap between words of one line. An OCR layer's sizes are
  // guessed small, so its gap is set tighter, or it bridges a gutter.
  const gapMax = typical * 2.5;
  // A box set beside the text, as Keywords beside an abstract, starts every
  // one of its lines at the same point. Ordinary words never line up like
  // that on four rows running, so such a point is a gutter no line crosses.
  const gutters: { x: number; top: number; bottom: number }[] = [];
  if (ocr) {
    const runs = new Map<number, number[]>();
    for (const p of parts) {
      if (p.x < view.width * 0.55) continue;
      const before = parts.filter((q) => q !== p && Math.abs(q.y - p.y) < p.h * 0.6 && q.x + q.w < p.x);
      const gap = before.length ? p.x - Math.max(...before.map((q) => q.x + q.w)) : Infinity;
      if (gap < typical * 1.2 || gap === Infinity) continue;
      const key = Math.round(p.x / 2);
      runs.set(key, [...(runs.get(key) ?? []), p.y]);
    }
    for (const [key, ys] of runs) {
      const rows = [...new Set(ys.map((y) => Math.round(y)))].sort((a, b) => b - a);
      let run = 1, best = 1;
      for (let i = 1; i < rows.length; i += 1) { run = rows[i - 1] - rows[i] < typical * 2.6 ? run + 1 : 1; best = Math.max(best, run); }
      if (best >= 4) gutters.push({ x: key * 2, top: rows[0] + typical * 2, bottom: rows[rows.length - 1] - typical });
    }
  }
  const across = (from: number, to: number) => gutters.some((g) => from < g.x - 1 && to > g.x - 3);
  const near = (l: RawLine, part: RawPart) =>
    (part.x >= l.x1 - 2 && part.x - l.x1 < gapMax && !across(l.x1, part.x))
    || (part.x + part.w <= l.x0 + 2 && l.x0 - (part.x + part.w) < gapMax && !across(part.x + part.w, l.x0));
  const sameRow = (l: RawLine, part: RawPart) => Math.abs(l.y - part.y) < Math.min(l.size, part.h) * 0.5;

  if (ocr) {
    // An OCR layer's word widths are guesses, so a gap between two words can
    // look as wide as a gutter. Its lines are therefore built a row at a time,
    // whatever the gaps. Each side of a gutter is done on its own, so a word
    // never joins a row across one.
    const clusterRows = (group: RawPart[]): RawLine[] => {
      const rows: RawLine[] = [];
      for (const part of group) {
        const bottom = part.y - part.h * 0.2, top = part.y + part.h * 0.8;
        let best: RawLine | null = null, bestShare = 0.5;
        for (const r of rows) {
          const overlap = Math.min(top, r.top!) - Math.max(bottom, r.bottom!);
          const share = overlap / Math.min(top - bottom, r.top! - r.bottom!);
          if (share > bestShare) { best = r; bestShare = share; }
        }
        if (best) {
          best.parts.push(part);
          best.x0 = Math.min(best.x0, part.x);
          best.x1 = Math.max(best.x1, part.x + part.w);
        } else {
          rows.push({ y: part.y, size: part.h, x0: part.x, x1: part.x + part.w, parts: [part], top, bottom });
        }
      }
      return rows;
    };
    // A column gutter: a point in the middle of the page that few rows cover,
    // where a stray wide gap between two words falls somewhere different on
    // every line.
    const first = clusterRows(parts).filter((r) => r.parts.length >= 3);
    let column: number | null = null;
    if (first.length >= 10) {
      let least = 1;
      for (let x = view.width * 0.35; x <= view.width * 0.65; x += 2) {
        const spanning = first.filter((r) => r.x0 < x - 20 && r.x1 > x + 20);
        const covered = spanning.filter((r) => r.parts.some((q) => q.x - 1 <= x && q.x + q.w + 1 >= x)).length;
        const share = covered / Math.max(1, spanning.length);
        if (spanning.length > first.length * 0.5 && share < least) { least = share; column = x; }
      }
      if (least > 0.15) column = null;
    }
    // Which side of each gutter a word is on: the column's, across the whole
    // page; a box's, only on the rows the box runs down.
    const side = (part: RawPart) => {
      let lane = column !== null && part.x >= column - 3 ? 1 : 0;
      for (const g of gutters) if (part.y <= g.top && part.y >= g.bottom && part.x >= g.x - 3) lane += 2;
      return lane;
    };
    const lanes = new Map<number, RawPart[]>();
    for (const part of parts) lanes.set(side(part), [...(lanes.get(side(part)) ?? []), part]);
    for (const group of lanes.values()) lines.push(...clusterRows(group));
  } else {
    for (const part of parts) {
      // Pieces join a line when they sit on it and are near it: a wide gutter
      // between them means two columns, not one line.
      const line = lines.find((l) => sameRow(l, part) && near(l, part));
      if (line) {
        line.parts.push(part);
        line.x0 = Math.min(line.x0, part.x);
        line.x1 = Math.max(line.x1, part.x + part.w);
      } else {
        lines.push({ y: part.y, size: part.h, x0: part.x, x1: part.x + part.w, parts: [part] });
      }
    }
  }
  lines.sort((a, b) => b.y - a.y || a.x0 - b.x0);
  // A line's baseline is its words' usual baseline, not the first word's.
  if (ocr) for (const l of lines) l.y = median(l.parts.map((p) => p.y));
  for (const l of lines) {
    l.parts.sort((a, b) => a.x - b.x);
    // A line's size is the size most of its letters are set in, so one word
    // set larger does not make the line a heading.
    const sizes: number[] = [];
    for (const p of l.parts) for (let k = 0; k < p.text.length; k += 1) sizes.push(p.h);
    l.size = median(sizes) || l.size;
  }
  // A drop capital: one large letter beside the first lines of a paragraph.
  // It joins the start of the topmost line beside it.
  for (const cap of [...lines]) {
    if (cap.parts.length !== 1) continue;
    const letter = cap.parts[0];
    if (letter.h < typical * 1.8 || letter.text.trim().length > 2 || !/^[A-Z\u201c"']/.test(letter.text.trim())) continue;
    const beside = lines
      .filter((l) => l !== cap && l.x0 > letter.x + letter.w - 2 && l.x0 - (letter.x + letter.w) < typical * 3 && l.y <= letter.y + letter.h * 0.85 && l.y >= letter.y - typical)
      .sort((a, b) => b.y - a.y)[0];
    if (!beside) continue;
    beside.parts.unshift({ ...letter, cap: true });
    beside.x0 = letter.x;
    lines.splice(lines.indexOf(cap), 1);
  }
  return { lines, width: view.width, height: view.height, ocr };
}

// Two columns are read left then right. A page counts as two columns when
// many of its lines sit wholly in one half or the other.
function edges(lines: RawLine[]) {
  const x0 = lines.map((l) => l.x0).sort((a, b) => a - b);
  const x1 = lines.map((l) => l.x1).sort((a, b) => a - b);
  // The column's edges: where most lines start, and where the longest lines end.
  const left = x0[Math.floor(x0.length * 0.3)] ?? 0;
  const right = x1[Math.floor(x1.length * 0.9)] ?? 0;
  for (const l of lines) { l.colLeft = left; l.colRight = right; }
}

function readingOrder(lines: RawLine[], width: number, height?: number): RawLine[] {
  // If this is a 2-up landscape spread with a clear centre gutter, read left page then right page.
  if (height && width > height * 1.15) {
    const mid = width / 2;
    const left = lines.filter((l) => l.x1 <= mid + 8);
    const right = lines.filter((l) => l.x0 >= mid - 8);
    const crossing = lines.filter((l) => l.x0 < mid - 8 && l.x1 > mid + 8).length;
    if (crossing <= lines.length * 0.15 && left.length >= lines.length * 0.25 && right.length >= lines.length * 0.25) {
      return [...readingOrder(left, mid, height), ...readingOrder(right, mid, height)];
    }
  }
  const mid = width / 2;
  const left = lines.filter((l) => l.x1 < mid + 8);
  const right = lines.filter((l) => l.x0 > mid - 8);
  // Many lines crossing the middle mean one column, however many short lines
  // there are: a list, a quotation, or the ends of paragraphs.
  const crossing = lines.filter((l) => l.x0 < mid - 8 && l.x1 > mid + 8).length;
  if (crossing > lines.length * 0.4 || left.length < lines.length * 0.3 || right.length < lines.length * 0.3) { edges(lines); return sidebarsLast(lines, width); }
  edges(left);
  edges(right);
  const spanning = lines.filter((l) => !left.includes(l) && !right.includes(l));
  edges(spanning.length ? spanning : []);
  const byY = (a: RawLine, b: RawLine) => b.y - a.y;
  // The columns begin at the first row where both columns have a line;
  // a running head in one half above that is not part of a column.
  const paired = left.filter((l) => right.some((r) => Math.abs(r.y - l.y) < l.size));
  const top = paired.length ? Math.max(...paired.map((l) => l.y)) : Math.max(...left.map((x) => x.y));
  const inColumns = (l: RawLine) => l.y <= top + l.size * 0.5;
  const above = lines.filter((l) => !inColumns(l)).sort(byY);
  return [...above, ...left.filter(inColumns).sort(byY), ...right.filter(inColumns).sort(byY), ...spanning.filter(inColumns).sort(byY)];
}

// A narrow box beside the text, as an article's Keywords beside its
// abstract, is read after the text it sits beside rather than woven into it.
function sidebarsLast(lines: RawLine[], width: number): RawLine[] {
  const typical = median(lines.map((l) => l.size)) || 10;
  const isSide = (l: RawLine) => l.x0 > width * 0.6 && lines.some((m) => m !== l && Math.abs(m.y - l.y) < l.size && m.x1 < l.x0 - typical * 2 && m.x0 < width * 0.4);
  const side = lines.filter(isSide);
  if (!side.length || side.length > lines.length * 0.3) return lines;
  const main = lines.filter((l) => !side.includes(l));
  for (const l of side) l.aside = true;
  const lowest = Math.min(...side.map((l) => l.y));
  // After the text that is narrowed to sit beside the box: the lines that
  // stop short of it, running on below the box until a line runs wide or a
  // gap opens, as before a new section.
  const boxLeft = Math.min(...side.map((l) => l.x0));
  const highest = Math.max(...side.map((l) => l.y));
  // First, every line on the rows the box runs down; then the narrowed lines
  // that continue below it, until one runs wide or a gap opens.
  let cut = main.findIndex((l) => l.y < lowest - typical * 0.5);
  if (cut < 0) cut = main.length;
  while (cut < main.length && main[cut].x1 < boxLeft - typical * 0.5
    && main[cut - 1].y - main[cut].y < typical * 2.2) cut += 1;
  void highest;
  return [...main.slice(0, cut), ...side, ...main.slice(cut)];
}

const signature = (text: string) => text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

export async function reflow(doc: PDFDocumentProxy): Promise<Reflowed> {
  const raw = [];
  for (let i = 0; i < doc.numPages; i += 1) raw.push(await readPage(doc, i));

  // Lines that repeat near the top or bottom of several pages are running heads.
  const edgeCounts = new Map<string, number>();
  raw.forEach(({ lines, height }) => {
    for (const l of lines) {
      if (l.y > height * 0.9 || l.y < height * 0.08) {
        const sig = signature(l.parts.map((p) => p.text).join(" "));
        edgeCounts.set(sig, (edgeCounts.get(sig) ?? 0) + 1);
      }
    }
  });
  const repeats = doc.numPages >= 3 ? 2 : 99;

  const allSizes: number[] = [];
  for (const { lines } of raw) for (const l of lines) for (const p of l.parts) for (let k = 0; k < p.text.length; k += 20) allSizes.push(Math.round(p.h * 2) / 2);
  const body = median(allSizes) || 10;

  const pages: PageText[] = [];
  const lines: Line[] = [];
  let chars = 0;
  const ocrDoc = raw.filter((r) => r.ocr).length > raw.length / 2;
  raw.forEach(({ lines: pageLines, width, height }, page) => {
    const pieces: Piece[] = [];
    let text = "";
    const pageJoined = pageLines.map((l) => l.parts.map((p) => p.text).join(" ")).join(" ");
    // Cover sheets from JSTOR, Taylor & Francis, or CLA/LSE digitisation are not part of the reading.
    const isCover = page === 0 && (
      /JSTOR is a not-for-profit|Your use of the JSTOR archive/i.test(pageJoined)
      || (/jstor\.org\/stable/i.test(pageJoined) && /(?:Chapter Title|Book Title|Author\(s\):|Source:)/i.test(pageJoined))
      || /To cite this article:|To link to this article:/i.test(pageJoined)
      || /(?:Extract title|Copyright Licensing Agency|Higher Education Licence|Course of study:)/i.test(pageJoined)
    );
    if (isCover) {
      pages.push({ page, text: "", pieces: [], height });
      return;
    }
    const order = readingOrder(pageLines, width, height);
    const lineGaps: number[] = [];
    for (let i = 0; i < order.length - 1; i += 1) {
      const cur = order[i], nxt = order[i + 1];
      if (cur.y > nxt.y && Math.abs(cur.x0 - nxt.x0) < body * 4) {
        lineGaps.push(cur.y - nxt.y);
      }
    }
    const pageLeading = median(lineGaps) || body * 1.3;

    for (const l of order) {
      let lineText = "";
      const start = text.length;
      // Footnote numbers set small and raised in the text are left out:
      // the notes themselves are not shown, so the numbers lead nowhere.
      const lineSize = median(l.parts.map((p) => p.h));
      const parts = l.parts.filter((part) => !(part.h < lineSize * 0.8 && /^[\d*\u2020\u2021]{1,3}[a-z]?$/.test(part.text.trim()) && part.y > l.y + lineSize * 0.12))
        // An OCR layer sets a note number at the size of the text and stuck
        // to it: "1914'1" or "men'.2". It is a number after closing
        // punctuation, and is left out as a raised one is.
        .map((part) => (ocrDoc ? { ...part, text: part.text.replace(/(?<=(?:\S['\u2019\u201d")\]]|[^\d\s][.,;:]))\d{1,3}(?=[.,;:)\]]{0,2}$)/, "") } : part));
      if (!parts.length) continue;
      parts.forEach((part, i) => {
        const prev = parts[i - 1];
        if (prev && !prev.cap) {
          const gap = part.x - (prev.x + prev.w);
          const threshold = ocrDoc ? -0.05 * Math.min(prev.h, part.h) : Math.min(prev.h, part.h) * 0.12;
          if (gap > threshold && !/\s$/.test(lineText) && !/^\s/.test(part.text)) { lineText += " "; text += " "; }
        }
        pieces.push({ start: text.length, end: text.length + part.text.length, rect: [part.x, part.y - part.h * 0.22, part.x + part.w, part.y + part.h * 0.8] });
        lineText += part.text;
        text += part.text;
      });
      text += "\n";
      const clean = lineText.replace(/\s+/g, " ").trim();
      if (!clean) continue;
      if (JUNK.test(clean) || PUBLISHER_FOOTER.test(clean)) continue;

      const startsLower = /^[a-z\u00e0-\u024f]/.test(clean);
      const isHyphen = HYPHEN_END.test(clean);
      const isSentenceContinuation = startsLower || isHyphen || /(?:,|;|:|\b(?:and|or|but|the|of|in|to|that|with|for))\s*$/i.test(clean);

      const nearEdge = l.y > height * 0.88 || l.y < height * 0.12;
      const isPageNum = /^(?:page\s+)?\d{1,4}(?:\s+(?:of|\/)\s+\d{1,4})?$/i.test(clean)
        || /^[ivxlcdm]{1,8}$/i.test(clean)
        || /^[-—–\s]*\d{1,4}[-—–\s]*$/.test(clean)
        || /^\[\s*\d{1,4}\s*\]$/.test(clean)
        || /^\d{1,4}\s*\|\s*.{2,60}$/.test(clean)
        || /^.{2,60}\s*\|\s*\d{1,4}$/.test(clean);

      if (nearEdge && isPageNum) continue;

      const isRepeatedEdge = (edgeCounts.get(signature(clean)) ?? 0) >= repeats && clean.length < 180;
      if (nearEdge && isRepeatedEdge && !isSentenceContinuation) continue;

      const below = order.find((other) => other !== l && other.y < l.y && Math.abs(other.x0 - l.x0) < body * 4);
      const isolatedTop = !below || (l.y - below.y > pageLeading * 1.6);
      const above = [...order].reverse().find((other) => other !== l && other.y > l.y && Math.abs(other.x0 - l.x0) < body * 4);
      const isolatedBottom = !above || (above.y - l.y > pageLeading * 1.6);
      const isolated = (l.y > height * 0.88 && isolatedTop) || (l.y < height * 0.12 && isolatedBottom);

      if (isolated && !isSentenceContinuation) {
        if (clean.length < 4 && !/[a-z]{2,}/i.test(clean)) continue;
        const marginBand = l.y > height * (ocrDoc ? 0.89 : 0.915) || l.y < height * 0.075;
        if (marginBand && l.size < body * 1.15 && clean.length < 110) continue;
      }

      // A line of nothing but small numbers is a stray footnote marker.
      if (/^[\d\s*\u2020\u2021.,]+$/.test(clean) && l.size < body * 0.9) continue;
      chars += clean.length;
      lines.push({
        page, start, end: start + lineText.length, text: lineText, hyphen: isHyphen, x0: l.x0, x1: l.x1, y: l.y, size: l.size, aside: l.aside,
        colLeft: l.colLeft ?? l.x0, colRight: l.colRight ?? l.x1,
      });
    }
    pages.push({ page, text, pieces, height });
  });

  // Joining lines into paragraphs. The one firm rule: a paragraph never
  // breaks in the middle of a sentence. A line that does not end a sentence
  // always runs on into the next, across a page turn, a column, a footnote
  // or anything else that came between them in print.
  const blocks: Block[] = [];
  const low = ocrDoc ? 0.78 : 0.86, high = ocrDoc ? 1.3 : 1.18;
  const paraLines = lines.filter((l) => l.size >= body * low && l.size <= body * high);
  const ends = (l: Line) => {
    const t = l.text.trim();
    if (l.hyphen) return false;
    if (ABBREV.test(t)) return false;
    return /[.?!:"'\u201d\u2019)\]]$/.test(t);
  };
  const shortShare = paraLines.filter((l) => l.x1 < l.colRight - l.size * 2.5).length / Math.max(1, paraLines.length);
  const ragged = shortShare > 0.35;

  const FOOTNOTE_MARKER = /^\d{1,3}(?:\.|\s)\s*[A-Z"'\u201c(]/;
  const SECTION_NUM = /^(?:[IVXLCDM]+\.?|\d{1,2}\.?|Chapter\s+\d+|Part\s+\d+|Section\s+\d+|Introduction|Conclusion|Epilogue|Preface|Foreword)\b/i;

  let open: Block | null = null; // the paragraph being built
  let lastPara: Line | null = null;
  let heading: Block | null = null;
  let note: Block | null = null;
  let lastNote: Line | null = null;
  let inNotePage = -1;
  let rollingLeft: number[] = [];

  for (const line of lines) {
    const t = line.text.trim();
    const pageH = raw[line.page]?.height ?? 800;
    const atBottom = line.y < pageH * 0.35;

    // Detect footnotes using position and marker patterns as well as font size.
    let isNote = line.size < body * low;
    if (atBottom && !line.aside) {
      if (inNotePage === line.page && line.size <= body * 1.0) {
        isNote = true;
      } else if (FOOTNOTE_MARKER.test(t)) {
        isNote = true;
        inNotePage = line.page;
      }
    }

    // Detect section headings: isolation + heading signal.
    const completed = !lastPara || ends(lastPara);
    const isolated = !lastPara || lastPara.page !== line.page || (lastPara.y - line.y > line.size * 1.35);
    const shortLine = t.length < 120 && !/[,;]$/.test(t);
    const centred = Math.abs((line.x0 + line.x1) / 2 - (line.colLeft + line.colRight) / 2) < line.size * 2 && (line.x1 - line.x0 < (line.colRight - line.colLeft) * 0.75);
    const allCaps = t.length >= 4 && t === t.toUpperCase() && /[A-Z]/.test(t);
    const titleWithoutNum = t.replace(/^(?:[IVXLCDM]+\.?|\d{1,2}\.?|Chapter\s+\d+|Part\s+\d+|Section\s+\d+)\s*/i, "");
    const isSectionHeading = SECTION_NUM.test(t) && (!/[.?!]$/.test(titleWithoutNum) || titleWithoutNum.length === 0);
    const isHeading = !line.aside && !isNote && shortLine && completed && isolated && (
      line.size > body * (ocrDoc ? 1.22 : 1.15) || centred || allCaps || isSectionHeading
    );

    let kind: Block["kind"] = line.aside ? "para" : isHeading ? "heading" : isNote ? "note" : "para";

    if (kind === "note") {
      if (!note || !lastNote || lastNote.page !== line.page) { note = { kind: "note", lines: [] }; blocks.push(note); }
      note.lines.push(line);
      lastNote = line;
      continue;
    }

    if (kind === "heading") {
      if (open && lastPara && !ends(lastPara)) kind = "para";
    }

    if (kind === "heading") {
      const continues = heading && heading.lines.length < 4 && heading.lines[heading.lines.length - 1].page === line.page;
      if (!continues) { heading = { kind: "heading", lines: [] }; blocks.push(heading); }
      heading!.lines.push(line);
      open = null;
      lastPara = null;
      continue;
    }
    heading = null;

    // Rolling left margin for jittered OCR scan baselines: seed with column edge
    if (lastPara && lastPara.page !== line.page) rollingLeft = [line.colLeft];
    if (!rollingLeft.length) rollingLeft.push(line.colLeft);
    if (Math.abs(line.x0 - line.colLeft) < line.size * 1.5) {
      rollingLeft.push(line.x0);
      if (rollingLeft.length > 5) rollingLeft.shift();
    }
    const localBaseline = median(rollingLeft) || line.colLeft;

    const startsLower = /^[a-z\u00e0-\u024f]/.test(t);
    let breakHere = !open || Boolean(line.aside) !== Boolean(lastPara?.aside);
    if (open && lastPara && Boolean(line.aside) === Boolean(lastPara.aside)) {
      if (startsLower) {
        breakHere = false;
      } else if (!ends(lastPara)) {
        const sameP = lastPara.page === line.page;
        const narrow = lastPara.x1 - lastPara.x0 < (lastPara.colRight - lastPara.colLeft) * 0.6;
        breakHere = sameP && narrow && lastPara.y - line.y > line.size * 2.2;
      } else {
        const samePage = lastPara.page === line.page;
        const gap = samePage ? lastPara.y - line.y : 0;
        const indentThreshold = ocrDoc ? localBaseline + line.size * 1.1 : line.colLeft + line.size * 0.85;
        const indent = line.x0 > indentThreshold && line.x0 < line.colLeft + line.size * 4;
        const short = lastPara.x1 < lastPara.colRight - line.size * 2.5;
        const wideGap = samePage && gap > line.size * 1.75;
        const newColumn = samePage && gap < 0;
        const isList = LIST_ITEM.test(t);
        breakHere = samePage
          ? wideGap || indent || isList || (!ragged && short && !newColumn)
          : /^[A-Z\u201c"'\d]/.test(t) && (indent || short || isList);
      }
    }
    if (breakHere) { open = { kind: "para", lines: [] }; blocks.push(open); }
    open!.lines.push(line);
    lastPara = line;
  }

  if (ocrDoc) glueSplitWords(blocks);

  const words = Math.round(chars / 6);
  // A scan with no text layer, or a page of figures, cannot be read as text.
  const usable = words > 80 * Math.min(doc.numPages, 3) / 3;
  return { blocks: blocks.filter((b) => b.lines.some((l) => l.text.trim())), pages, words, usable };
}

// The rectangles on a page covered by part of its text, for saving a highlight.
export function rectsFor(page: PageText, start: number, end: number): number[][] {
  const out: number[][] = [];
  for (const p of page.pieces) {
    if (p.end <= start || p.start >= end) continue;
    const len = Math.max(1, p.end - p.start);
    const w = p.rect[2] - p.rect[0];
    const a = Math.max(start, p.start) - p.start;
    const b = Math.min(end, p.end) - p.start;
    out.push([p.rect[0] + (w * a) / len, p.rect[1], p.rect[0] + (w * b) / len, p.rect[3]].map((n) => Math.round(n * 100) / 100));
  }
  return out;
}

// The stretches of a page's text that a highlight's rectangles cover.
export function rangesFor(page: PageText, rects: number[][]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of page.pieces) {
    const len = p.end - p.start;
    const w = p.rect[2] - p.rect[0] || 1;
    for (const r of rects) {
      const overlapY = Math.min(r[3], p.rect[3]) - Math.max(r[1], p.rect[1]);
      if (overlapY < (p.rect[3] - p.rect[1]) * 0.3) continue;
      const x1 = Math.max(r[0], p.rect[0]);
      const x2 = Math.min(r[2], p.rect[2]);
      if (x2 - x1 < 1) continue;
      const a = p.start + Math.floor(((x1 - p.rect[0]) / w) * len);
      const b = p.start + Math.ceil(((x2 - p.rect[0]) / w) * len);
      out.push([a, Math.min(b, p.end)]);
    }
  }
  return out.sort((x, y) => x[0] - y[0]);
}

// How far down its page a character sits, from 0 at the top to 1 at the foot.
export function fracOf(page: PageText, at: number): number {
  const piece = page.pieces.find((p) => p.end > at) ?? page.pieces[page.pieces.length - 1];
  if (!piece || !page.height) return 0;
  return Math.min(1, Math.max(0, (page.height - piece.rect[3]) / page.height));
}

// The first character on a page at or below a point that far down it.
export function atOf(page: PageText, frac: number): number {
  const y = page.height * (1 - frac);
  const piece = page.pieces.find((p) => p.rect[3] <= y + 2) ?? page.pieces[page.pieces.length - 1];
  return piece ? piece.start : 0;
}

// Short words that often end a line on their own, and so are never taken
// for the first half of a word split across lines.
const WHOLE = new Set("a an the of to in on at by for and but or nor as is it be we he she his her its our us me my so no not was are had has did do if then than that this who how why all any can may new one two out up off own per via yet our they them who whom with from into over upon also only even such each both".split(" "));

const ENDING = /^(tions?|sions?|ations?|ments?|ness(es)?|ships?|ally|ingly|ings?|ences?|ances?|ency|ancy|ities|ity|ives?|ously|ous|ible|able|ably|isms?|ists?|ised|ized|ising|izing|ated|ating|ary|ory|ure|ures)$/;

// An OCR layer often drops the hyphen of a word broken across lines, leaving
// "histori" at the end of one line and "ans" at the start of the next. They
// are rejoined when the document itself shows the whole word elsewhere, or
// when one half is plainly not a word: a short start that is not a known
// short word, or a short end that never appears on its own.
function glueSplitWords(blocks: Block[]): void {
  const counts = new Map<string, number>();
  const words = (text: string) => text.trim().split(/\s+/);
  const clean = (w: string) => w.toLowerCase().replace(/^[^a-z\u00c0-\u024f]+|[^a-z\u00c0-\u024f]+$/g, "");
  // Words inside lines only: the halves at line ends are what is in doubt.
  for (const block of blocks) for (const line of block.lines) {
    const w = words(line.text);
    for (let i = 1; i < w.length - 1; i += 1) { const c = clean(w[i]); if (c) counts.set(c, (counts.get(c) ?? 0) + 1); }
  }
  for (const block of blocks) {
    if (block.kind === "heading") continue;
    block.lines.forEach((line, i) => {
      const next = block.lines[i + 1];
      if (!next || line.hyphen) return;
      // An opening quotation mark or bracket before the first half is no bar.
      const a = (words(line.text).pop() ?? "").replace(/^['\u2018\u201c"(\[]+/, "");
      const b = words(next.text)[0] ?? "";
      // Only a bare fragment: letters to the end, a lower-case start after.
      if (!/^[A-Za-z\u00c0-\u024f]{2,}$/.test(a) || !/^[a-z\u00e0-\u024f]{2,}[a-z\u00e0-\u024f.,;:'\u2019)-]*$/.test(b)) return;
      const whole = clean(a + b.split("-")[0]);
      const ca = clean(a), cb = clean(b.split("-")[0]);
      if ((counts.get(whole) ?? 0) > 0
        || (!counts.has(ca) && ca.length <= 4 && !WHOLE.has(ca))
        || (!counts.has(cb) && cb.length <= 6 && !WHOLE.has(cb) && !counts.has(ca) && !WHOLE.has(ca) && ca.length <= 7)
        // A second half that is only a word ending, after a first half that
        // is not a word in its own right: "complica" and "tions".
        || (ENDING.test(cb) && !counts.has(ca) && !WHOLE.has(ca) && ca.length >= 3)) line.glue = true;
    });
  }
}
