// Helpers for an essay's external sources and its word count, kept out of the
// component so they can be tested. Footnote and bibliography text is plain text
// that goes straight into Word, so it carries no Markdown markers.

import { computeFootnoteNumbers, type DocxDocument, type DocxFootnote, type WordCountBreakdown } from "./docx";

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

// The three groups an essay's sources fall into. Course readings and reading found
// outside the course are both secondary, but are kept apart so that the essay's
// own research can be seen at a glance against what the module set.
export type EssaySourceCategory = "primary" | "secondary_course" | "secondary_outside";

export const ESSAY_SOURCE_CATEGORIES: readonly EssaySourceCategory[] = ["primary", "secondary_course", "secondary_outside"];

export const ESSAY_SOURCE_CATEGORY_LABEL: Record<EssaySourceCategory, string> = {
  primary: "Primary",
  secondary_course: "Secondary (course)",
  secondary_outside: "Secondary (outside)",
};

export function isEssaySourceCategory(value: unknown): value is EssaySourceCategory {
  return value === "primary" || value === "secondary_course" || value === "secondary_outside";
}

// Reads a stored kind as one of the three groups. The older plain "secondary" kind
// predates the split and only ever meant course reading, so it becomes
// "secondary_course"; anything unrecognised takes the fallback instead.
export function normaliseSourceCategory(
  raw: unknown,
  fallback: EssaySourceCategory = "secondary_course",
): EssaySourceCategory {
  if (isEssaySourceCategory(raw)) return raw;
  if (raw === "secondary") return "secondary_course";
  return fallback;
}

// What kind of primary source a reading is, which names the field that holds its
// details on the source card (the newspaper, where a speech was given, and so on).
export type PrimaryType =
  | "document"
  | "letter"
  | "diary"
  | "official"
  | "newspaper"
  | "speech"
  | "image"
  | "treaty"
  | "other";

export const PRIMARY_TYPES: readonly PrimaryType[] = [
  "document",
  "letter",
  "diary",
  "official",
  "newspaper",
  "speech",
  "image",
  "treaty",
  "other",
];

export const PRIMARY_TYPE_LABEL: Record<PrimaryType, string> = {
  document: "Archive document",
  letter: "Letter",
  diary: "Diary or memoir",
  official: "Official paper",
  newspaper: "Newspaper",
  speech: "Speech",
  image: "Image",
  treaty: "Treaty or law",
  other: "Other",
};

export function isPrimaryType(value: unknown): value is PrimaryType {
  return typeof value === "string" && (PRIMARY_TYPES as readonly string[]).includes(value);
}

// What one essay knows about one of its sources beyond the source itself: the group it
// is shown in and, for a primary source, its type. It is kept on the essay rather than on
// the reading, so that the same reading can sit in a different group in another essay
// and the readings table keeps the columns the server already has.
export interface SourceMeta {
  category?: EssaySourceCategory;
  primaryType?: PrimaryType;
}

// Reads the stored map, keeping only the values it knows, so that a malformed entry
// synced from another device never puts a source in a group that does not exist. The
// older plain "secondary" is read as course reading, as it is everywhere else.
export function normaliseSourceMeta(raw: unknown): Record<string, SourceMeta> {
  const out: Record<string, SourceMeta> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const meta: SourceMeta = {};
    if (isEssaySourceCategory(entry.category) || entry.category === "secondary") meta.category = normaliseSourceCategory(entry.category);
    if (isPrimaryType(entry.primaryType)) meta.primaryType = entry.primaryType;
    if (meta.category || meta.primaryType) out[id] = meta;
  }
  return out;
}

// Sources are listed alphabetically, as a bibliography is, with accents, case, quotation
// marks and an opening bracket ignored and numbers read as numbers, so that "Bront\u00eb"
// sorts with "Bronte", "2 Kings" comes before "10 Kings", and a title sorts the same in
// quotation marks as out of them, as a reading with no author is shown in them.
const TITLE_COLLATOR = new Intl.Collator("en-GB", { sensitivity: "base", numeric: true });
const QUOTATION_MARKS = /["'\u2018\u2019\u201c\u201d]/g;
const LEADING_MARKS = /^[\s([]+/;

const titleSortKey = (title: string) => title.replace(QUOTATION_MARKS, "").replace(LEADING_MARKS, "");

export function compareSourceTitles(a: string, b: string): number {
  return TITLE_COLLATOR.compare(titleSortKey(a), titleSortKey(b));
}

export interface SourceGroup<T> {
  category: EssaySourceCategory;
  label: string;
  sources: T[];
}

function defaultCategoryOf(source: { kind?: unknown }): EssaySourceCategory {
  return normaliseSourceCategory(source.kind);
}

// Sorts sources into Primary, Secondary (course) and Secondary (outside), always
// in that order and always with all three groups, so a list does not jump about as
// a group empties. Each group keeps the order the sources were given in.
export function groupSourcesByCategory<T extends { kind?: unknown }>(
  sources: readonly T[],
  categoryOf: (source: T) => EssaySourceCategory = defaultCategoryOf,
): SourceGroup<T>[] {
  const buckets = new Map<EssaySourceCategory, T[]>(ESSAY_SOURCE_CATEGORIES.map((c) => [c, []]));
  for (const source of sources) buckets.get(categoryOf(source))?.push(source);
  return ESSAY_SOURCE_CATEGORIES.map((category) => ({
    category,
    label: ESSAY_SOURCE_CATEGORY_LABEL[category],
    sources: buckets.get(category) ?? [],
  }));
}

// The fields a search looks through, loose enough for custom sources, uploaded
// papers and reading list items alike.
export interface SearchableSourceFields {
  title?: string | null;
  name?: string | null;
  author?: string | null;
  year?: string | number | null;
  publisher?: string | null;
  notes?: string | null;
  kind?: unknown;
}

export interface SourceFilter {
  query?: string | null;
  category?: EssaySourceCategory | "all" | null;
}

// Lower case with accents removed, so that "Bronte" finds "Bront\u00eb".
function foldForSearch(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function sourceSearchText(source: SearchableSourceFields): string {
  return foldForSearch(
    [source.title, source.name, source.author, source.year, source.publisher, source.notes]
      .map((part) => (part === null || part === undefined ? "" : String(part).trim()))
      .filter(Boolean)
      .join(" "),
  );
}

// Keeps the sources in the chosen group whose text holds every word of the query,
// in any order, which narrows a list of twenty or thirty sources without needing
// the exact title. An empty query and no group returns every source, in order.
export function filterSources<T extends SearchableSourceFields>(
  sources: readonly T[],
  filter: SourceFilter = {},
  categoryOf: (source: T) => EssaySourceCategory = defaultCategoryOf,
): T[] {
  const words = foldForSearch(filter.query ?? "").split(/\s+/).filter(Boolean);
  const category = filter.category && filter.category !== "all" ? filter.category : null;
  return sources.filter((source) => {
    if (category && categoryOf(source) !== category) return false;
    if (!words.length) return true;
    const text = sourceSearchText(source);
    return words.every((word) => text.includes(word));
  });
}

// A reference from the essay to a source. It points at a passage by default, by
// page, passage, highlight or quotation, and only covers the whole work when
// wholeDocument is set. The label and footnote text are the writer's own wording,
// held beside the link so that renaming them never loses the source or passage.
export interface SourceLink {
  id: string;
  sourceId: string;
  page?: string;
  passage?: string;
  highlightId?: string;
  quote?: string;
  wholeDocument?: boolean;
  footnoteId?: string;
  label?: string;
  footnoteText?: string;
  // Set while a footnote for this link is waiting to be added in the word processor, to
  // the key of the word processor tab that asked for it, so that only that tab adds it.
  awaitingInsert?: string;
  created_at?: string;
  updated_at?: string;
}

const LINK_TEXT_FIELDS = ["page", "passage", "highlightId", "quote", "footnoteId", "label", "footnoteText", "awaitingInsert", "created_at", "updated_at"] as const;

function cleanText(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

// Reads a stored link, so that a malformed one synced from another device is
// dropped rather than shown as a reference to nothing. A page stored as a number
// is kept as text, and wholeDocument is only kept when it is actually true.
export function normaliseSourceLink(raw: unknown): SourceLink | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = cleanText(obj.id);
  const sourceId = cleanText(obj.sourceId);
  if (!id || !sourceId) return null;
  const link: SourceLink = { id, sourceId };
  for (const field of LINK_TEXT_FIELDS) {
    const value = cleanText(obj[field]);
    if (value !== undefined) link[field] = value;
  }
  if (obj.wholeDocument === true) link.wholeDocument = true;
  return link;
}

// Reads a stored list of links, keeping the first of any that share an id.
export function normaliseSourceLinks(raw: unknown): SourceLink[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const links: SourceLink[] = [];
  for (const entry of raw) {
    const link = normaliseSourceLink(entry);
    if (!link || seen.has(link.id)) continue;
    seen.add(link.id);
    links.push(link);
  }
  return links;
}

export type SourceLinkInput = Omit<SourceLink, "created_at" | "updated_at">;

// Makes a new link stamped with the time, throwing when it lacks an id or a source
// because a reference to nothing would only fail later, somewhere harder to trace.
export function createSourceLink(input: SourceLinkInput, now: string = new Date().toISOString()): SourceLink {
  const link = normaliseSourceLink({ ...input, created_at: now, updated_at: now });
  if (!link) throw new Error("A source link needs an id and a source id.");
  return link;
}

// The locator a footnote cites, such as "p. 12" or "pp. 12-14". A page already
// written with its own "p." is left alone, a passage stands in when there is no
// page, and a link to the whole work has no locator at all.
export function sourceLinkLocator(link: Pick<SourceLink, "page" | "passage" | "wholeDocument">): string | null {
  if (link.wholeDocument) return null;
  const page = link.page?.trim();
  if (page) {
    if (/^pp?\.?\s/i.test(page)) return page;
    return /[-,\u2013]/.test(page) ? `pp. ${page}` : `p. ${page}`;
  }
  return link.passage?.trim() || null;
}

export interface ResolvedSourceLink<T> {
  link: SourceLink;
  source: T | null;
  missing: boolean;
  locator: string | null;
  label: string;
  footnoteText: string;
}

// The source a link points to, with the label and footnote text to show. The
// writer's own wording wins; otherwise both are drawn from the source and its
// locator. A link whose source has been deleted is still returned, marked missing,
// so that the reference can be shown and repaired rather than silently vanish.
export function resolveSourceLink<T extends { id: string } & ExternalSourceFields>(
  link: SourceLink,
  sources: readonly T[],
  formatNote: (source: T, locator: string | null) => string = formatCustomFootnote,
): ResolvedSourceLink<T> {
  const source = sources.find((s) => s.id === link.sourceId) ?? null;
  const locator = sourceLinkLocator(link);
  const title = source?.title.trim() || "Missing source";
  const defaultLabel = locator ? `${title}, ${locator}` : title;
  return {
    link,
    source,
    missing: source === null,
    locator,
    label: link.label?.trim() || defaultLabel,
    footnoteText: link.footnoteText?.trim() || (source ? formatNote(source, locator) : ""),
  };
}

// The parts of a link that can change after it is made. Its id and source are left
// out on purpose, so that no edit can detach a link from what it cites. An empty
// string or null clears a field, which returns a label or footnote to its default.
export type SourceLinkPatch = {
  [K in Exclude<keyof SourceLink, "id" | "sourceId" | "created_at" | "updated_at">]?: SourceLink[K] | null;
};

// Applies a patch to one link and returns a new list. Turning wholeDocument on
// keeps the page and passage, so turning it off again restores them. The same list
// comes back when no link has that id, so a caller can tell nothing changed.
export function updateSourceLink(
  links: SourceLink[],
  id: string,
  patch: SourceLinkPatch,
  now: string = new Date().toISOString(),
): SourceLink[] {
  const index = links.findIndex((link) => link.id === id);
  if (index < 0) return links;
  const next: Record<string, unknown> = { ...links[index] };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "id" || key === "sourceId" || key === "created_at" || key === "updated_at" || value === undefined) continue;
    if (value === null || value === false || (typeof value === "string" && !value.trim())) delete next[key];
    else next[key] = value;
  }
  next.updated_at = now;
  const updated = normaliseSourceLink(next);
  if (!updated) return links;
  const copy = links.slice();
  copy[index] = updated;
  return copy;
}

// Renames a link's label, and optionally its footnote text, without touching the
// source or passage it points at.
export function renameSourceLink(
  links: SourceLink[],
  id: string,
  label: string | null,
  footnoteText?: string | null,
  now?: string,
): SourceLink[] {
  const patch: SourceLinkPatch = footnoteText === undefined ? { label } : { label, footnoteText };
  return updateSourceLink(links, id, patch, now);
}

// Each of these returns the same list when nothing matches, for the same reason.
export function removeSourceLink(links: SourceLink[], id: string): SourceLink[] {
  const next = links.filter((link) => link.id !== id);
  return next.length === links.length ? links : next;
}

export function removeLinksForSource(links: SourceLink[], sourceId: string): SourceLink[] {
  const next = links.filter((link) => link.sourceId !== sourceId);
  return next.length === links.length ? links : next;
}

export function removeLinksForFootnote(links: SourceLink[], footnoteId: string): SourceLink[] {
  const next = links.filter((link) => link.footnoteId !== footnoteId);
  return next.length === links.length ? links : next;
}

export function linksForSource(links: readonly SourceLink[], sourceId: string): SourceLink[] {
  return links.filter((link) => link.sourceId === sourceId);
}

// A reference can draw on several highlights. Each is a link of its own on the same
// footnote, rather than a list on one link, because a device on an earlier version keeps
// every link it is sent but drops any field it does not know, so a list would be lost the
// first time such a device saved the essay.
export function linksForFootnote(links: readonly SourceLink[], footnoteId: string): SourceLink[] {
  return links.filter((link) => link.footnoteId === footnoteId);
}

// The highlights a reference draws on, in the order they were added, each named once.
export function passageHighlightIds(links: readonly SourceLink[], footnoteId: string): string[] {
  const ids: string[] = [];
  for (const link of links) {
    if (link.footnoteId === footnoteId && link.highlightId && !ids.includes(link.highlightId)) ids.push(link.highlightId);
  }
  return ids;
}

export interface PassageLinkInput {
  id: string;
  footnoteId: string;
  sourceId: string;
  highlightId: string;
  quote?: string;
  page?: string;
}

// Adds one highlight to a reference. The highlights it already draws on from the same
// source stay, while a link to the whole work, to a page alone or to another source goes,
// because the passage now says where the reference points; a name the writer gave such a
// link is kept on the new one. The same list comes back when the highlight is there already.
export function addPassageLink(links: SourceLink[], input: PassageLinkInput, now: string = new Date().toISOString()): SourceLink[] {
  const onNote = linksForFootnote(links, input.footnoteId);
  if (onNote.some((link) => link.highlightId === input.highlightId && link.sourceId === input.sourceId)) return links;
  const replaced = onNote.filter((link) => !link.highlightId || link.sourceId !== input.sourceId);
  const label = replaced.find((link) => link.label)?.label;
  const added = createSourceLink({ ...input, ...(label ? { label } : {}) }, now);
  return [...links.filter((link) => !replaced.includes(link)), added];
}

// Takes one highlight out of a reference, leaving the highlight itself in the reading.
export function removePassageLink(links: SourceLink[], footnoteId: string, highlightId: string): SourceLink[] {
  const next = links.filter((link) => !(link.footnoteId === footnoteId && link.highlightId === highlightId));
  return next.length === links.length ? links : next;
}

// The locator for a reference made of several links: each page it cites, once and in
// order, as "pp. 12, 15". One link, or links with no page, read exactly as a single link does.
export function referenceLocator(links: readonly SourceLink[]): string | null {
  if (!links.length) return null;
  if (links.length === 1) return sourceLinkLocator(links[0]);
  const pages: string[] = [];
  for (const link of links) {
    const page = link.wholeDocument ? undefined : link.page?.trim();
    if (page && !pages.includes(page)) pages.push(page);
  }
  if (!pages.length) return sourceLinkLocator(links[0]);
  pages.sort((a, b) => (Number.parseInt(a, 10) || 0) - (Number.parseInt(b, 10) || 0) || a.localeCompare(b));
  return sourceLinkLocator({ page: pages.join(", ") });
}

// How many references a set of links makes, counting the links on one footnote once, so a
// confirmation never counts one reference's highlights as several references.
export function referenceCount(links: readonly SourceLink[]): number {
  return new Set(links.map((link) => link.footnoteId ?? `link:${link.id}`)).size;
}

// Footnote text as it is compared across a save: trimmed, with runs of space made one
// and curly quotation marks made straight, since Word may change either on its own.
export function normaliseFootnoteText(text: string): string {
  return text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();
}

export interface FootnoteCarry {
  draft: DocxDocument;
  sourceLinks: SourceLink[];
}

// A draft read back from Word gives every footnote a new id and keeps none of the
// sources they cite, so this carries both across from the draft that was saved before.
// Footnotes are paired by their text first, then the links waiting for a new footnote
// claim theirs by its text, and what is left is paired in order when as many notes went
// as came, which is a note reworded in place. pairByOrder is turned off for a document
// that replaces the draft outright, whose notes have nothing to do with the old ones.
// A link whose footnote has gone keeps its source and passage as a page reference.
// The same draft and the same list come back when nothing needed to change.
export function carryFootnoteBindings(
  prev: DocxDocument,
  next: DocxDocument,
  links: SourceLink[],
  options: { pairByOrder?: boolean; now?: string } = {},
): FootnoteCarry {
  const now = options.now ?? new Date().toISOString();
  const byText = new Map<string, DocxFootnote[]>();
  for (const note of prev.footnotes) {
    const key = normaliseFootnoteText(note.text);
    byText.set(key, [...(byText.get(key) ?? []), note]);
  }

  // The earlier footnote each new one continues, by index in the new draft.
  const continues = new Map<number, DocxFootnote>();
  const paired = new Set<DocxFootnote>();
  next.footnotes.forEach((note, index) => {
    const match = byText.get(normaliseFootnoteText(note.text))?.shift();
    if (!match) return;
    continues.set(index, match);
    paired.add(match);
  });

  // A link waiting for a new footnote takes the first unpaired one with its text.
  const claimed = new Map<string, number>();
  const taken = new Set<number>();
  for (const link of links) {
    if (!link.awaitingInsert || link.footnoteId || !link.footnoteText) continue;
    const text = normaliseFootnoteText(link.footnoteText);
    const index = next.footnotes.findIndex((note, at) => !continues.has(at) && !taken.has(at) && normaliseFootnoteText(note.text) === text);
    if (index < 0) continue;
    claimed.set(link.id, index);
    taken.add(index);
  }

  if (options.pairByOrder !== false) {
    const leftOld = prev.footnotes.filter((note) => !paired.has(note));
    const leftNew = next.footnotes.map((_, index) => index).filter((index) => !continues.has(index) && !taken.has(index));
    if (leftOld.length && leftOld.length === leftNew.length) leftNew.forEach((index, at) => continues.set(index, leftOld[at]));
  }

  const renamed = new Map<string, string>();
  let draftChanged = false;
  const footnotes = next.footnotes.map((note, index) => {
    const before = continues.get(index);
    if (!before) return note;
    renamed.set(before.id, note.id);
    const carried: DocxFootnote = { ...note };
    if (!carried.citationItemId && before.citationItemId) carried.citationItemId = before.citationItemId;
    if (!carried.locator && before.locator) carried.locator = before.locator;
    if (carried.citationItemId === note.citationItemId && carried.locator === note.locator) return note;
    draftChanged = true;
    return carried;
  });

  const oldIds = new Set(prev.footnotes.map((note) => note.id));
  const newIds = new Set(next.footnotes.map((note) => note.id));
  let linksChanged = false;
  const sourceLinks = links.map((link) => {
    const index = claimed.get(link.id);
    if (index !== undefined) {
      const note = footnotes[index];
      if (note.citationItemId !== link.sourceId) {
        footnotes[index] = { ...note, citationItemId: link.sourceId };
        draftChanged = true;
      }
      linksChanged = true;
      const bound: SourceLink = { ...link, footnoteId: note.id, updated_at: now };
      delete bound.awaitingInsert;
      return bound;
    }
    if (!link.footnoteId) return link;
    const target = oldIds.has(link.footnoteId) ? renamed.get(link.footnoteId) : newIds.has(link.footnoteId) ? link.footnoteId : undefined;
    if (target === link.footnoteId) return link;
    linksChanged = true;
    if (target) return { ...link, footnoteId: target, updated_at: now };
    const detached: SourceLink = { ...link, updated_at: now };
    delete detached.footnoteId;
    return detached;
  });

  return {
    draft: draftChanged ? { ...next, footnotes } : next,
    sourceLinks: linksChanged ? sourceLinks : links,
  };
}
