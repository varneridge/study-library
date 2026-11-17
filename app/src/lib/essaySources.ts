// Helpers for an essay's external sources and its word count, kept out of the
// component so they can be tested. Footnote and bibliography text is plain text
// that goes straight into Word, so it carries no Markdown markers.

import { computeFootnoteNumbers, type DocxDocument, type WordCountBreakdown } from "./docx";

// The fields of a custom source these helpers read, so any richer source type fits.
export interface ExternalSourceFields {
  author?: string | null;
  title: string;
  year?: string | number | null;
  kind?: "primary" | "secondary" | string | null;
  publisher?: string | null;
  url?: string | null;
}

// Returns the URL only when it is an absolute http or https address, because a stored
// value such as `javascript:` would otherwise run script when the link is followed.
export function safeExternalUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function publication(source: ExternalSourceFields): string {
  return [source.publisher?.trim(), source.year ? String(source.year).trim() : ""].filter(Boolean).join(", ");
}

// A Chicago style note: Author, Title (Publisher, Year), locator, URL.
export function formatCustomFootnote(source: ExternalSourceFields, locator?: string | null): string {
  const title = source.kind === "primary" ? `\u201c${source.title.trim()}\u201d` : source.title.trim();
  let note = source.author?.trim() ? `${source.author.trim()}, ${title}` : title;
  const pub = publication(source);
  if (pub) note += ` (${pub})`;
  if (locator?.trim()) note += `, ${locator.trim()}`;
  const url = safeExternalUrl(source.url);
  if (url) note += `, ${url}`;
  return `${note.replace(/[.\s]+$/, "")}.`;
}

// A Chicago style bibliography entry: Author. Title. Publisher, Year. URL.
export function formatCustomBibliography(source: ExternalSourceFields): string {
  const parts: string[] = [];
  if (source.author?.trim()) parts.push(`${source.author.trim().replace(/\.$/, "")}.`);
  const title = source.title.trim().replace(/\.$/, "");
  parts.push(source.kind === "primary" ? `\u201c${title}.\u201d` : `${title}.`);
  const pub = publication(source);
  if (pub) parts.push(`${pub}.`);
  const url = safeExternalUrl(source.url);
  if (url) parts.push(`${url}.`);
  return parts.join(" ");
}

// The count shown against the target, honouring both the footnote toggle and the
// draft's own quotation setting, so turning footnotes off can never raise the count.
export function effectiveWordCount(
  counts: WordCountBreakdown,
  doc: DocxDocument,
  includeFootnotes: boolean,
): number {
  const includeQuotes = doc.settings?.includeQuotesInCount !== false;
  return counts.body + (includeQuotes ? counts.quotes : 0) + (includeFootnotes ? counts.footnotes : 0);
}

// Footnotes in the order and with the numbers Word gives them, for the page preview.
export function numberedFootnotes(doc: DocxDocument): { id: string; number: number; text: string }[] {
  const numbers = computeFootnoteNumbers(doc);
  return doc.footnotes
    .map((fn) => ({ id: fn.id, number: numbers.get(fn.id) ?? Number.MAX_SAFE_INTEGER, text: fn.text }))
    .sort((a, b) => a.number - b.number);
}

// A full stop, question mark or ellipsis, with any closing quotation or
// bracket, that is followed by a capital letter (after any opening quotation
// or bracket). Requiring the capital keeps "c. 1914" and "e.g. the" whole.
const SENTENCE_END = /[.!?\u2026]["'\u201d\u2019)\]]*\s+(?=["'\u201c\u2018(\[]?\p{Lu})/gu;

// The sentence that a citation at offset belongs to, for "Cited where?". A
// note follows its punctuation, so the sentence that ends just before the
// offset is the one returned, along with any clause before a mid-sentence note.
export function sentenceBefore(text: string, offset: number = text.length): string {
  const end = Math.min(Math.max(0, Math.trunc(offset) || 0), text.length);
  // Trimmed first, so the sentence's own closing full stop is never a boundary.
  const head = text.slice(0, end).replace(/\s+$/, "");
  let start = 0;
  for (const match of head.matchAll(SENTENCE_END)) start = (match.index ?? 0) + match[0].length;
  return head.slice(start).replace(/\s+/g, " ").trim();
}

// Where a footnote is cited in the draft: the block that holds its marker and
// the sentence leading up to it. The footnote is named by its id or by the
// number Word gives it, and null means the draft does not cite it.
export function findCitationContext(doc: DocxDocument, ref: string | number): { blockId: string; sentence: string } | null {
  const id = typeof ref === "number"
    ? [...computeFootnoteNumbers(doc)].find(([, number]) => number === ref)?.[0]
    : ref;
  if (!id) return null;
  for (const block of doc.blocks) {
    let text = "";
    for (const run of block.runs ?? []) {
      if (run.type === "footnote_ref" && run.footnoteId === id) return { blockId: block.id, sentence: sentenceBefore(text) };
      if (run.type === "text") text += run.text ?? "";
    }
  }
  return null;
}
