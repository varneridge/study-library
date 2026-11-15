// The reader's contents list. A PDF's own outline is used wherever it has
// one, read to any depth and with every kind of destination resolved. A
// document without one is read for its printed contents page first, and
// failing that is given headings found by their larger type or by their
// wording ("Chapter 3", "Part II", "1.2 Methods"), so a scanned book, an OCR
// copy set in one size or an exported chapter still opens with a usable list.

import type { PDFDocumentProxy } from "pdfjs-dist";

export interface Heading { title: string; page: number; level: number }
export type Tab = "notes" | "pages" | "contents";

// Deeper entries are kept but drawn at this level, because a long book's
// list stays readable when indentation stops growing.
export const MAX_OUTLINE_LEVEL = 3;
// The fallback reads only a book's opening pages, since that is where its
// structure is announced and reading further would cost time on every open.
export const SCAN_PAGES = 40;
export const MAX_FOUND_HEADINGS = 60;

// Control characters, runs of space and the dot leaders of a printed
// contents page are removed, while a title's own numbers ("Chapter 3") stay.
export function cleanHeadingTitle(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*[.\u2026\u00b7]{3,}\s*\d*\s*$/, "")
    .trim();
}

export interface OutlineNode { title: string; dest: unknown; items?: OutlineNode[] }

// The two calls of a PDFDocumentProxy this needs, so tests can pass a stub.
export interface DestinationSource {
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

// A destination is a name to look up, an explicit array whose first entry is
// a page reference, or, in some files, that array with a plain page index.
async function pageOf(dest: unknown, doc: DestinationSource): Promise<number | null> {
  const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
  if (!Array.isArray(explicit)) return null;
  const ref = explicit[0];
  if (typeof ref === "number") return Number.isInteger(ref) && ref >= 0 ? ref : null;
  if (ref && typeof ref === "object") return doc.getPageIndex(ref);
  return null;
}

export async function flattenOutline(
  nodes: readonly OutlineNode[] | null | undefined,
  doc: DestinationSource,
): Promise<Heading[]> {
  const out: Heading[] = [];
  const walk = async (list: readonly OutlineNode[], level: number): Promise<void> => {
    for (const node of list) {
      const title = cleanHeadingTitle(node.title ?? "");
      let page: number | null = null;
      try {
        page = await pageOf(node.dest, doc);
      } catch {
        // An entry pointing nowhere is passed over, but its children are still read.
        page = null;
      }
      const last = out[out.length - 1];
      const repeat = last !== undefined && last.title === title && last.page === page;
      if (title && page !== null && !repeat) out.push({ title, page, level: Math.min(level, MAX_OUTLINE_LEVEL) });
      if (node.items?.length) await walk(node.items, level + 1);
    }
  };
  await walk(nodes ?? [], 0);
  return out;
}

export interface TextLine { page: number; text: string; size: number }

// A printed contents page is only looked for near the front, where books put it.
export const TOC_SCAN_PAGES = 13;
// A contents page can run on for a few pages after its heading.
const TOC_CONTINUATION_PAGES = 3;
const MAX_TOC_ENTRIES = 300;

const TOC_TITLE = /^((table\s+of\s+)?contents|inhalt|sommaire|indice)$/i;
// A title with at least one letter, then dot leaders or plain space, then the
// printed page number that ends the line.
const TOC_ENTRY = /^(.*?\p{L}.*?)(?:\s*[.\u2026\u00b7_](?:[\s.\u2026\u00b7_]*)|\s+)(\d{1,4})$/u;
// "Chapter 12" alone on a line is the start of a wrapped entry, not a title
// pointing at page 12.
const TOC_LABEL_ONLY = /\b(chapter|part|section|book|appendix)$/i;
// A wrapped title is joined to the line below it only when the break clearly
// falls mid-phrase, so an unnumbered part heading never swallows the next entry.
const TOC_JOINS = /(\b(of|the|and|in|a|an|to|for|on|with|from|by|at|or)|[,:;])$/i;

// Wording that marks a heading even when OCR has set every line in one size.
// The keyword forms ignore case; the numbered forms are matched with case
// intact, since a case-blind roman numeral would also match words like "did".
const STRUCTURAL_WORD = /^(chapter\s+(\d+|[ivxlcdm]+)\b|part\s+([ivxlcdm]+|\d+)\b|section\s+\d+|(introduction|conclusion|epilogue|prologue|preface)\s*(:.*)?$|appendix\b)/i;
const STRUCTURAL_NUMBER = /^([IVXLCDM]+\.\s+\p{Lu}|\d{1,2}(\.\d{1,2})?\.?\s+\p{Lu})/u;
const SUBSECTION = /^(section\s+\d|\d{1,2}\.\d)/i;

function squash(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\ufeff]/g, " ").replace(/\s+/g, " ").trim();
}

// Whether a line reads as a heading by its wording alone. It must be short
// and must not end in a full stop, since a sentence of body text is neither.
export function isStructuralHeading(text: string): boolean {
  const line = squash(text);
  if (!line || line.length >= 100 || line.endsWith(".")) return false;
  return STRUCTURAL_WORD.test(line) || STRUCTURAL_NUMBER.test(line);
}

// The key used to spot running headers, with the page number that often sits
// beside a header taken off, so "12 The Origins of War" and "14 The Origins
// of War" count as the same repeated line.
function runningKey(text: string): string {
  return cleanHeadingTitle(text).toLowerCase().replace(/^\d+\s+|\s+\d+$/g, "");
}

// A title reduced to its words for matching a contents entry against the
// heading it names, with chapter labels and numbering removed from the front.
function matchKey(text: string): string {
  return squash(text)
    .replace(/^(chapter|part|section|book)\s+(\d+|[ivxlcdm]+)\b\s*[:.-]?\s*/i, "")
    // Roman numerals are only stripped in capitals, so "Civil War" keeps its first word.
    .replace(/^(\d+(\.\d+)*|[IVXLCDM]+)\.?\s+/, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

interface TocEntry { title: string; printed: number }

function parseTocEntry(text: string): TocEntry | null {
  const line = squash(text);
  const match = TOC_ENTRY.exec(line);
  if (!match) return null;
  const title = cleanHeadingTitle(match[1].replace(/[\s.\u2026\u00b7_]+$/, ""));
  if (title.length < 2 || title.length > 120 || TOC_LABEL_ONLY.test(title)) return null;
  return { title, printed: Number(match[2]) };
}

// Headings taken from a printed contents page, for a book whose PDF has no
// outline but whose front matter lists its chapters with page numbers. The
// printed numbers are turned into PDF pages by finding where the first entries
// actually begin, or, failing that, by assuming the first entry follows the
// contents page directly.
export function headingsFromContentsPage(lines: readonly TextLine[], pageCount?: number): Heading[] {
  const byPage = new Map<number, TextLine[]>();
  for (const l of lines) {
    if (!l.text.trim()) continue;
    const list = byPage.get(l.page) ?? [];
    list.push(l);
    byPage.set(l.page, list);
  }
  const maxPrinted = pageCount !== undefined ? pageCount + 50 : 2000;
  const pages = [...byPage.keys()].filter((p) => p < TOC_SCAN_PAGES).sort((a, b) => a - b);

  for (const tocPage of pages) {
    const pageLines = byPage.get(tocPage)!;
    const at = pageLines.findIndex((l) => TOC_TITLE.test(squash(l.text).replace(/[:.]$/, "")));
    if (at < 0) continue;

    const entries: TocEntry[] = [];
    let pending = "";
    const take = (list: readonly TextLine[]) => {
      for (const l of list) {
        const entry = parseTocEntry(l.text);
        if (entry) {
          const joined = pending && (TOC_JOINS.test(pending) || /^\p{Ll}/u.test(entry.title));
          entries.push(joined ? { ...entry, title: cleanHeadingTitle(`${pending} ${entry.title}`) } : entry);
          pending = "";
        } else {
          const line = squash(l.text);
          pending = line.length < 80 && /\p{L}/u.test(line) ? line : "";
        }
      }
    };
    take(pageLines.slice(at + 1));
    let lastTocPage = tocPage;
    for (let next = tocPage + 1; next <= tocPage + TOC_CONTINUATION_PAGES; next++) {
      const list = byPage.get(next) ?? [];
      const found = list.filter((l) => parseTocEntry(l.text)).length;
      if (found < 3 || found * 2 < list.length) break;
      take(list);
      lastTocPage = next;
    }

    // Printed page numbers only ever rise down a contents page, so a number
    // that falls back, or one beyond any plausible page, is a date or a stray
    // figure rather than an entry.
    const ordered: TocEntry[] = [];
    for (const e of entries) {
      if (e.printed > maxPrinted) continue;
      const last = ordered[ordered.length - 1];
      if (last && e.printed < last.printed) continue;
      ordered.push(e);
    }
    if (ordered.length < 2) continue;

    let offset = lastTocPage + 1 - ordered[0].printed;
    search: for (const e of ordered.slice(0, 5)) {
      const key = matchKey(e.title);
      if (key.length < 3) continue;
      for (const l of lines) {
        if (l.page <= lastTocPage) continue;
        const candidate = matchKey(l.text);
        if (!candidate) continue;
        const same = candidate === key
          || (key.length >= 6 && candidate.startsWith(key))
          || (candidate.length >= 12 && key.startsWith(candidate));
        if (same) {
          offset = l.page - e.printed;
          break search;
        }
      }
    }

    const lastIndex = pageCount !== undefined ? Math.max(0, pageCount - 1) : Number.POSITIVE_INFINITY;
    const out: Heading[] = [];
    for (const e of ordered) {
      const page = Math.max(0, Math.min(lastIndex, e.printed + offset));
      const prev = out[out.length - 1];
      if (prev && prev.title === e.title && prev.page === page) continue;
      out.push({ title: e.title, page, level: SUBSECTION.test(e.title) ? 1 : 0 });
      if (out.length >= MAX_TOC_ENTRIES) break;
    }
    return out;
  }
  return [];
}

// Headings for a document with no outline of its own. A printed contents page
// is preferred when one is found. Otherwise the body size is the one most
// characters are set in; a line well above it is a heading, the largest
// becoming top-level entries, and a body-sized line whose wording marks it as
// a chapter or section is a heading too, so an OCR copy set in one size still
// gets its structure. Text repeated on three or more pages is taken for a
// running header and left out.
export function headingsFromLines(lines: readonly TextLine[], pageCount?: number): Heading[] {
  const usable = lines.filter((l) => l.size > 0 && l.text.trim());
  if (!usable.length) return [];

  const printed = headingsFromContentsPage(usable, pageCount);
  if (printed.length >= 2) return printed;

  const bySize = [...usable].sort((a, b) => a.size - b.size);
  const total = bySize.reduce((n, l) => n + l.text.length, 0);
  let seen = 0;
  let body = bySize[0].size;
  for (const l of bySize) {
    seen += l.text.length;
    if (seen * 2 >= total) { body = l.size; break; }
  }

  // Adjacent large lines on one page in one size are a single wrapped title.
  // A heading found by its wording stands alone, because a numbered heading
  // is complete on its own line.
  const merged: (TextLine & { structural: boolean })[] = [];
  let previousLarge = false;
  for (const l of usable) {
    const large = l.size >= body * 1.2;
    const structural = !large && l.size >= body * 0.95 && isStructuralHeading(l.text);
    const prev = merged[merged.length - 1];
    if (large && previousLarge && prev && !prev.structural && prev.page === l.page && Math.abs(prev.size - l.size) < 0.5) {
      prev.text = `${prev.text} ${l.text}`;
    } else if (large || structural) {
      merged.push({ ...l, structural });
    }
    previousLarge = large;
  }

  const pagesByText = new Map<string, Set<number>>();
  for (const m of merged) {
    const key = runningKey(m.text);
    const pages = pagesByText.get(key) ?? new Set<number>();
    pages.add(m.page);
    pagesByText.set(key, pages);
  }

  const out: Heading[] = [];
  for (const m of merged) {
    const title = cleanHeadingTitle(m.text);
    if (title.length < 3 || title.length > 120 || !/\p{L}/u.test(title)) continue;
    if ((pagesByText.get(runningKey(m.text))?.size ?? 0) >= 3) continue;
    const level = m.structural ? (SUBSECTION.test(title) ? 1 : 0) : m.size >= body * 1.6 ? 0 : 1;
    out.push({ title, page: m.page, level });
    if (out.length >= MAX_FOUND_HEADINGS) break;
  }
  // A single large line is a title page, not a structure worth a tab.
  return out.length >= 2 ? out : [];
}

// pdf.js text items gathered into lines: items on one baseline in one size
// are joined, since pdf.js often splits a line into several items.
export function linesOf(page: number, items: readonly unknown[]): TextLine[] {
  const out: TextLine[] = [];
  let baseline: number | null = null;
  for (const raw of items) {
    if (!raw || typeof raw !== "object" || !("str" in raw) || !("transform" in raw)) continue;
    const item = raw as { str: string; transform: number[] };
    const size = Math.round(Math.hypot(item.transform[2], item.transform[3]) * 10) / 10;
    const y = item.transform[5];
    const prev = out[out.length - 1];
    const sameLine = prev !== undefined && baseline !== null
      && Math.abs(y - baseline) < Math.max(1, size * 0.5) && Math.abs(prev.size - size) < 0.5;
    if (sameLine) prev.text += item.str;
    else if (item.str.trim()) out.push({ page, text: item.str, size });
    else continue;
    baseline = y;
  }
  return out;
}

export async function outline(
  doc: PDFDocumentProxy,
  opts: { scanPages?: number; cancelled?: () => boolean } = {},
): Promise<Heading[]> {
  const nodes = (await doc.getOutline().catch(() => null)) as OutlineNode[] | null;
  const own = await flattenOutline(nodes, doc as unknown as DestinationSource);
  if (own.length) return own;
  const lines: TextLine[] = [];
  const last = Math.min(doc.numPages, opts.scanPages ?? SCAN_PAGES);
  for (let i = 0; i < last; i++) {
    if (opts.cancelled?.()) return [];
    try {
      const page = await doc.getPage(i + 1);
      const content = await page.getTextContent();
      lines.push(...linesOf(i, content.items));
    } catch {
      // A page that cannot be read is passed over rather than ending the scan.
    }
  }
  return headingsFromLines(lines, doc.numPages);
}

// The sidebar opens on the contents until you choose a tab for this reading.
// The contents tab is always shown, with a short note when a reading has
// none, so the heading count no longer moves you elsewhere.
export function defaultTab(current: Tab, _headingCount: number, touched: boolean): Tab {
  return touched ? current : "contents";
}
