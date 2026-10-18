// Display titles, built only from the fields that exist.

import type { ItemRow } from "./types";

type Citation = Pick<ItemRow, "kind" | "author" | "year" | "title" | "source" | "pages" | "doc_date">;

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

export function fullTitle(item: Citation): string {
  if (item.kind === "primary") {
    const title = item.author ? quoted(item.title) : item.title;
    return curl(join([item.author, title, item.source, item.doc_date], ", "));
  }
  if (item.kind === "slides") return item.title;
  const head = join([item.author, item.year && `(${item.year})`, item.title && quoted(item.title)], " ");
  return curl(join([head, item.source, item.pages && `pp. ${item.pages}`], ", "));
}

// Authors are kept in one form: "Surname, I.", two joined by "and", more
// by commas and a final "and". This reads the surnames back out.
export function surnames(author: string | null | undefined): string[] {
  if (!author) return [];
  const [rest, last] = author.includes(" and ") ? [author.slice(0, author.lastIndexOf(" and ")), author.slice(author.lastIndexOf(" and ") + 5)] : [author, null];
  const people = rest.split(/(?<=\.),\s+(?=[A-Z\u00C0-\u024F])/);
  if (last) people.push(last);
  return people.map((p) => p.split(",")[0].trim()).filter(Boolean);
}

// "Chen", "Chen and Westad", or "Chen et al." for three or more.
export function shortAuthor(author: string | null | undefined): string | null {
  const names = surnames(author);
  if (!names.length) return null;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} et al.`;
}

export function shortTitle(item: Citation): string {
  if (item.kind !== "secondary") return fullTitle(item);
  return join([shortAuthor(item.author), item.year && `(${item.year})`, quoted(item.title)], " ");
}

// A title split in two: what you scan for, and where it was published.
export function titleParts(item: Citation): { main: string; sub: string } {
  if (item.kind === "slides") return { main: item.title, sub: "" };
  if (item.kind === "primary") {
    const title = item.author ? quoted(item.title) : item.title;
    return { main: curl(join([item.author, title], ", ")), sub: curl(join([item.source, item.doc_date], ", ")) };
  }
  const main = join([item.author, item.year && `(${item.year})`, item.title && quoted(item.title)], " ");
  return { main: curl(main), sub: curl(join([item.source, item.pages && `pp. ${item.pages}`], ", ")) };
}
