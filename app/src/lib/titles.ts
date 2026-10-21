// Display titles and Chicago 18th edition citations (Notes and Bibliography).

import type { ItemRow, WorkKind } from "./types";

export interface CitationItem {
  title: string;
  kind?: ItemRow["kind"];
  work_kind?: WorkKind | null;
  author?: string | null;
  editor?: string | null;
  year?: number | null;
  source?: string | null;
  publisher?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  doc_date?: string | null;
  doi?: string | null;
}

// Titles are shown in typographic quotation marks, as a bibliography sets
// them, with any apostrophe inside curled to match. The stored title is
// left as it was typed.
function quoted(title: string): string {
  return `\u2018${title.replace(/'/g, "\u2019")}\u2019`;
}

// Apostrophes elsewhere in a citation, as in "Mao's China", curl too, so
// one line never mixes the two kinds.
function curl(text: string): string {
  return text.replace(/(\w)'(\w)/g, "$1\u2019$2");
}

function join(parts: (string | number | null | undefined | false)[], separator: string): string {
  return parts.filter((part): part is string => typeof part === "string" && part.trim() !== "").join(separator);
}

export interface Person {
  surname: string;
  given: string;
}

// Splits an author or editor string into individual people.
// Handles "Surname, Given", "Surname, I.", "Surname, Given and Surname, Given",
// and three or more people joined by commas and "and".
export function parsePeople(raw: string | null | undefined): Person[] {
  if (!raw) return [];
  const text = raw.trim();
  if (!text) return [];

  const andIdx = text.lastIndexOf(" and ");
  const [rest, last] = andIdx >= 0
    ? [text.slice(0, andIdx).replace(/,\s*$/, "").trim(), text.slice(andIdx + 5).trim()]
    : [text, null];

  const people: Person[] = [];

  const parseOne = (str: string): Person => {
    const s = str.trim();
    if (!s) return { surname: "", given: "" };
    if (s.includes(",")) {
      const comma = s.indexOf(",");
      return { surname: s.slice(0, comma).trim(), given: s.slice(comma + 1).trim() };
    }
    return { surname: s, given: "" };
  };

  if (last !== null) {
    if (last.includes(",")) {
      const chunks = rest.split(/,\s*/);
      if (chunks.length % 2 === 0) {
        for (let i = 0; i < chunks.length; i += 2) {
          people.push({ surname: chunks[i].trim(), given: chunks[i + 1].trim() });
        }
      } else {
        const parts = rest.split(/(?<=\.),\s+(?=[A-Z\u00C0-\u024F])/);
        for (const p of parts) people.push(parseOne(p));
      }
    } else {
      const parts = rest.split(/,\s*/);
      for (const p of parts) people.push({ surname: p.trim(), given: "" });
    }
    people.push(parseOne(last));
  } else {
    const chunks = rest.split(/,\s*/);
    if (chunks.length === 2) {
      people.push({ surname: chunks[0].trim(), given: chunks[1].trim() });
    } else if (chunks.length > 2 && chunks.length % 2 === 0) {
      for (let i = 0; i < chunks.length; i += 2) {
        people.push({ surname: chunks[i].trim(), given: chunks[i + 1].trim() });
      }
    } else {
      const parts = rest.split(/(?<=\.),\s+(?=[A-Z\u00C0-\u024F])/);
      for (const p of parts) people.push(parseOne(p));
    }
  }

  return people.filter((p) => p.surname || p.given);
}

// Reads surnames back out: ["Chen"], ["Chen", "Westad"], etc.
export function surnames(author: string | null | undefined): string[] {
  return parsePeople(author).map((p) => p.surname).filter(Boolean);
}

// "Chen", "Chen and Westad", or "Chen et al." for three or more.
export function shortAuthor(author: string | null | undefined): string | null {
  const names = surnames(author);
  if (!names.length) return null;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} et al.`;
}

// How the source/container is formatted in library lists and headers.
function sourceDisplay(item: CitationItem): string | null {
  const kind = inferWorkKind(item);
  let src = item.source ? item.source.trim() : null;
  if (!src) return null;
  if (kind === "chapter" && !/^in\s+/i.test(src)) {
    src = `in ${src}`;
  }
  if (kind === "article" && item.volume && !new RegExp(`\\b${item.volume}\\b`).test(src)) {
    src = `${src} ${item.volume}${item.issue ? ` (${item.issue})` : ""}`;
  }
  return src;
}

export function fullTitle(item: CitationItem): string {
  if (item.kind === "primary") {
    const title = item.author ? quoted(item.title) : item.title;
    return curl(join([item.author, title, item.source, item.doc_date], ", "));
  }
  if (item.kind === "slides") return item.title;
  const head = join([item.author, item.year && `(${item.year})`, item.title && quoted(item.title)], " ");
  return curl(join([head, sourceDisplay(item), item.pages && `pp. ${item.pages}`], ", "));
}

export function shortTitle(item: CitationItem): string {
  if (item.kind !== "secondary") return fullTitle(item);
  return join([shortAuthor(item.author), item.year && `(${item.year})`, quoted(item.title)], " ");
}

// A title split in two: what you scan for, and where it was published.
export function titleParts(item: CitationItem): { main: string; sub: string } {
  if (item.kind === "slides") return { main: item.title, sub: "" };
  if (item.kind === "primary") {
    const title = item.author ? quoted(item.title) : item.title;
    return { main: curl(join([item.author, title], ", ")), sub: curl(join([item.source, item.doc_date], ", ")) };
  }
  const main = join([item.author, item.year && `(${item.year})`, item.title && quoted(item.title)], " ");
  return { main: curl(main), sub: curl(join([sourceDisplay(item), item.pages && `pp. ${item.pages}`], ", ")) };
}

// Infers work kind ('article', 'chapter', 'book', or 'primary') from fields.
export function inferWorkKind(item: CitationItem): WorkKind {
  if (item.work_kind) return item.work_kind;
  if (item.kind === "primary") return "primary";
  const src = (item.source || "").trim();
  if (item.editor || /^in\s+/i.test(src) || (src && item.publisher)) return "chapter";
  if (!src && !item.volume) return "book";
  return "article";
}

function cleanEndPeriod(s: string): string {
  return s.trim().replace(/\.+$/, "");
}

function formatDoiUrl(doi: string | null | undefined): string | null {
  if (!doi) return null;
  const d = doi.trim();
  if (!d) return null;
  if (/^https?:\/\//i.test(d)) return d;
  if (d.startsWith("10.")) return `https://doi.org/${d}`;
  return d;
}

// Chicago 18th edition bibliography author format:
// 1 author: Surname, Given.
// 2 authors: Surname, Given, and Given Surname.
// 3+ authors: Surname, Given, Given Surname, and Given Surname.
function formatAuthorsBiblio(people: Person[]): string {
  if (!people.length) return "";
  const first = people[0];
  const firstStr = first.given ? `${first.surname}, ${first.given}` : first.surname;
  if (people.length === 1) return cleanEndPeriod(firstStr) + ".";

  const others = people.slice(1).map((p) => (p.given ? `${p.given} ${p.surname}` : p.surname));
  if (others.length === 1) {
    return `${cleanEndPeriod(firstStr)}, and ${cleanEndPeriod(others[0])}.`;
  }
  const rest = others.slice(0, -1).map(cleanEndPeriod).join(", ");
  const last = cleanEndPeriod(others[others.length - 1]);
  return `${cleanEndPeriod(firstStr)}, ${rest}, and ${last}.`;
}

// Chicago 18th edition note author format:
// 1 author: Given Surname
// 2 authors: Given Surname and Given Surname
// 3+ authors: Given Surname et al.
function formatAuthorsNote(people: Person[]): string {
  if (!people.length) return "";
  const names = people.map((p) => (p.given ? `${p.given} ${p.surname}` : p.surname));
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} et al.`;
}

function formatEditorsList(people: Person[]): string {
  if (!people.length) return "";
  const names = people.map((p) => (p.given ? `${p.given} ${p.surname}` : p.surname));
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

// Formats a full Chicago 18th edition bibliography entry (Notes and Bibliography style).
export function chicagoBibliography(item: CitationItem): string {
  const workKind = inferWorkKind(item);
  const authors = parsePeople(item.author);
  const editors = parsePeople(item.editor);
  const authorStr = formatAuthorsBiblio(authors);
  const doiUrl = formatDoiUrl(item.doi);

  if (workKind === "article") {
    const title = item.title ? `\u201c${cleanEndPeriod(item.title)}.\u201d` : "";
    let journal = item.source ? item.source.trim() : "";
    let vol = item.volume ? item.volume.trim() : "";
    let iss = item.issue ? item.issue.trim() : "";
    if (!vol && journal) {
      const match = journal.match(/^(.*?)(?:\s+(\d+))?(?:\s*\(([^)]+)\))?$/);
      if (match && (match[2] || match[3])) {
        journal = match[1].trim();
        vol = match[2] || "";
        iss = match[3] || "";
      }
    }
    let citation = journal;
    if (vol) citation += ` ${vol}`;
    if (iss) citation += `, no. ${iss}`;
    if (item.year) citation += ` (${item.year})`;
    if (item.pages) citation += `: ${item.pages}`;
    citation = cleanEndPeriod(citation) + ".";

    const parts = [authorStr, title, citation, doiUrl ? `${doiUrl}.` : null];
    return curl(parts.filter(Boolean).join(" "));
  }

  if (workKind === "chapter") {
    const title = item.title ? `\u201c${cleanEndPeriod(item.title)}.\u201d` : "";
    let book = (item.source || "").replace(/^in\s+/i, "").trim();
    if (!editors.length && /^(.*?),?\s*\(eds?\.?\),?\s*(.*)$/i.test(book)) {
      const m = book.match(/^(.*?),?\s*\(eds?\.?\),?\s*(.*)$/i);
      if (m) book = m[2].trim();
    }
    let inPart = book ? `In ${cleanEndPeriod(book)}` : "In";
    if (editors.length) {
      inPart += `, edited by ${formatEditorsList(editors)}`;
    }
    if (item.pages) {
      inPart += `, ${item.pages}`;
    }
    inPart = cleanEndPeriod(inPart) + ".";

    let pubPart = "";
    if (item.publisher && item.year) {
      pubPart = `${cleanEndPeriod(item.publisher)}, ${item.year}.`;
    } else if (item.publisher) {
      pubPart = `${cleanEndPeriod(item.publisher)}.`;
    } else if (item.year) {
      pubPart = `${item.year}.`;
    }

    const parts = [authorStr, title, inPart, pubPart, doiUrl ? `${doiUrl}.` : null];
    return curl(parts.filter(Boolean).join(" "));
  }

  if (workKind === "book") {
    let lead = authorStr;
    if (!lead && editors.length) {
      const edNames = formatAuthorsBiblio(editors);
      lead = cleanEndPeriod(edNames) + (editors.length === 1 ? ", ed." : ", eds.");
    }
    const title = item.title ? `${cleanEndPeriod(item.title)}.` : "";
    let pubPart = "";
    if (item.publisher && item.year) {
      pubPart = `${cleanEndPeriod(item.publisher)}, ${item.year}.`;
    } else if (item.publisher) {
      pubPart = `${cleanEndPeriod(item.publisher)}.`;
    } else if (item.year) {
      pubPart = `${item.year}.`;
    }

    const parts = [lead, title, pubPart, doiUrl ? `${doiUrl}.` : null];
    return curl(parts.filter(Boolean).join(" "));
  }

  // Primary source
  const lead = authorStr ? cleanEndPeriod(authorStr) + "." : "";
  const title = item.title ? `\u201c${cleanEndPeriod(item.title)}.\u201d` : "";
  const dateStr = item.doc_date ? `${cleanEndPeriod(item.doc_date)}.` : item.year ? `${item.year}.` : "";
  const container = item.source ? `${cleanEndPeriod(item.source)}.` : "";
  const parts = [lead, title, dateStr, container, doiUrl ? `${doiUrl}.` : null];
  return curl(parts.filter(Boolean).join(" "));
}

// Formats a Chicago 18th edition note entry (footnote or endnote).
export function chicagoNote(item: CitationItem, page?: number | string | null): string {
  const workKind = inferWorkKind(item);
  const authors = parsePeople(item.author);
  const editors = parsePeople(item.editor);
  const authorStr = formatAuthorsNote(authors);
  const doiUrl = formatDoiUrl(item.doi);

  if (workKind === "article") {
    const title = item.title ? `\u201c${cleanEndPeriod(item.title)},\u201d` : "";
    let journal = item.source ? item.source.trim() : "";
    let vol = item.volume ? item.volume.trim() : "";
    let iss = item.issue ? item.issue.trim() : "";
    if (!vol && journal) {
      const match = journal.match(/^(.*?)(?:\s+(\d+))?(?:\s*\(([^)]+)\))?$/);
      if (match && (match[2] || match[3])) {
        journal = match[1].trim();
        vol = match[2] || "";
        iss = match[3] || "";
      }
    }
    let citation = journal;
    if (vol) citation += ` ${vol}`;
    if (iss) citation += `, no. ${iss}`;
    if (item.year) citation += ` (${item.year})`;
    const targetPage = page ?? item.pages;
    if (targetPage) citation += `: ${targetPage}`;
    citation = cleanEndPeriod(citation) + (doiUrl ? "," : ".");

    const lead = authorStr ? `${authorStr}, ` : "";
    const parts = [`${lead}${title} ${citation}`.trim(), doiUrl ? `${doiUrl}.` : null];
    return curl(parts.filter(Boolean).join(" "));
  }

  if (workKind === "chapter") {
    const title = item.title ? `\u201c${cleanEndPeriod(item.title)},\u201d` : "";
    let book = (item.source || "").replace(/^in\s+/i, "").trim();
    if (!editors.length && /^(.*?),?\s*\(eds?\.?\),?\s*(.*)$/i.test(book)) {
      const m = book.match(/^(.*?),?\s*\(eds?\.?\),?\s*(.*)$/i);
      if (m) book = m[2].trim();
    }
    let inPart = book ? `in ${book}` : "in";
    if (editors.length) {
      inPart += `, ed. ${formatEditorsList(editors)}`;
    }
    let pubInfo = "";
    if (item.publisher && item.year) pubInfo = ` (${cleanEndPeriod(item.publisher)}, ${item.year})`;
    else if (item.publisher) pubInfo = ` (${cleanEndPeriod(item.publisher)})`;
    else if (item.year) pubInfo = ` (${item.year})`;
    inPart += pubInfo;

    const targetPage = page ?? item.pages;
    if (targetPage) inPart += `, ${targetPage}`;
    inPart = cleanEndPeriod(inPart) + (doiUrl ? "," : ".");

    const lead = authorStr ? `${authorStr}, ` : "";
    const parts = [`${lead}${title} ${inPart}`.trim(), doiUrl ? `${doiUrl}.` : null];
    return curl(parts.filter(Boolean).join(" "));
  }

  if (workKind === "book") {
    let lead = authorStr;
    if (!lead && editors.length) {
      lead = formatEditorsList(editors) + (editors.length === 1 ? ", ed." : ", eds.");
    }
    const title = item.title ? cleanEndPeriod(item.title) : "";
    let pubInfo = "";
    if (item.publisher && item.year) pubInfo = ` (${cleanEndPeriod(item.publisher)}, ${item.year})`;
    else if (item.publisher) pubInfo = ` (${cleanEndPeriod(item.publisher)})`;
    else if (item.year) pubInfo = ` (${item.year})`;

    let body = title + pubInfo;
    if (page) body += `, ${page}`;
    body = cleanEndPeriod(body) + (doiUrl ? "," : ".");

    const prefix = lead ? `${lead}, ` : "";
    const parts = [`${prefix}${body}`.trim(), doiUrl ? `${doiUrl}.` : null];
    return curl(parts.filter(Boolean).join(" "));
  }

  // Primary source
  const lead = authorStr ? `${authorStr}, ` : "";
  const title = item.title ? `\u201c${cleanEndPeriod(item.title)},\u201d` : "";
  const dateStr = item.doc_date ? cleanEndPeriod(item.doc_date) : item.year ? String(item.year) : "";
  const container = item.source ? cleanEndPeriod(item.source) : "";
  let body = [dateStr, container].filter(Boolean).join(", ");
  body = cleanEndPeriod(body) + (doiUrl ? "," : ".");
  const parts = [`${lead}${title} ${body}`.trim(), doiUrl ? `${doiUrl}.` : null];
  return curl(parts.filter(Boolean).join(" "));
}
