// The reader's contents list. A PDF's own outline is used wherever it has
// one, read to any depth and with every kind of destination resolved, and a
// document without one is given headings found by their larger type, so a
// scanned book or an exported chapter still opens with a usable list.

import type { PDFDocumentProxy } from "pdfjs-dist";

export interface Heading { title: string; page: number; level: number }
export type Tab = "notes" | "pages" | "contents";
export type ReaderTab = Tab;

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

// Headings found by type size, for a document with no outline of its own.
// The body size is the one most characters are set in; a line well above it
// is a heading, the largest becoming top-level entries, and text repeated on
// three or more pages is taken for a running header and left out.
export function headingsFromLines(lines: readonly TextLine[]): Heading[] {
  const usable = lines.filter((l) => l.size > 0 && l.text.trim());
  if (!usable.length) return [];
  const bySize = [...usable].sort((a, b) => a.size - b.size);
  const total = bySize.reduce((n, l) => n + l.text.length, 0);
  let seen = 0;
  let body = bySize[0].size;
  for (const l of bySize) {
    seen += l.text.length;
    if (seen * 2 >= total) { body = l.size; break; }
  }

  // Adjacent large lines on one page in one size are a single wrapped title.
  const merged: TextLine[] = [];
  let previousLarge = false;
  for (const l of usable) {
    const large = l.size >= body * 1.25;
    const prev = merged[merged.length - 1];
    if (large && previousLarge && prev && prev.page === l.page && Math.abs(prev.size - l.size) < 0.5) {
      prev.text = `${prev.text} ${l.text}`;
    } else if (large) {
      merged.push({ ...l });
    }
    previousLarge = large;
  }

  const pagesByText = new Map<string, Set<number>>();
  for (const m of merged) {
    const key = cleanHeadingTitle(m.text).toLowerCase();
    const pages = pagesByText.get(key) ?? new Set<number>();
    pages.add(m.page);
    pagesByText.set(key, pages);
  }

  const out: Heading[] = [];
  for (const m of merged) {
    const title = cleanHeadingTitle(m.text);
    if (title.length < 3 || title.length > 120 || !/\p{L}/u.test(title)) continue;
    if ((pagesByText.get(title.toLowerCase())?.size ?? 0) >= 3) continue;
    out.push({ title, page: m.page, level: m.size >= body * 1.6 ? 0 : 1 });
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
  return headingsFromLines(lines);
}

// The sidebar opens on the contents whenever a reading has them, unless you
// have already chosen a tab for this reading, and it never stays on a
// contents tab that has nothing in it.
export function defaultTab(current: ReaderTab, headingCount: number, touched: boolean): ReaderTab {
  if (headingCount > 0 && !touched) return "contents";
  if (current === "contents" && headingCount === 0) return "notes";
  return current;
}
