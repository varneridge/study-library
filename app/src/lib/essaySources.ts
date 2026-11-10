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
