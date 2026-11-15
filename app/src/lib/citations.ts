// Citations the processor found in a reading's PDF, and what you can do
// with them: use one, keep your own, or put back what was there before.

import { api, update } from "./sync";
import type { ItemRow, Suggestion } from "./types";
import { showToast } from "./ui";

export function viaLabel(via: Suggestion["via"]): string {
  switch (via) {
    case "crossref": return "from the DOI printed in the PDF, checked with Crossref";
    case "jstor": return "from the JSTOR cover page";
    case "crossref-title": return "by matching the title on its first page with Crossref";
    case "layout": return "from the title and names on its first page";
    case "metadata": return "from the PDF's own details";
    case "isbn": return "from the ISBN printed in it, checked with a library catalogue";
    case "isbn-chapter": return "from the ISBN of the book it comes from, with the title on its first page";
    default: return "from the PDF";
  }
}

export function pending(item: ItemRow): Suggestion | null {
  const s = item.suggested;
  return s && !s.applied && !s.dismissed ? s : null;
}

const fieldsOf = (s: Pick<Suggestion, "work_kind" | "author" | "editor" | "year" | "title" | "source" | "publisher" | "volume" | "issue" | "pages" | "doc_date" | "doi">) => ({
  work_kind: s.work_kind ?? null,
  author: s.author ?? null,
  editor: s.editor ?? null,
  year: s.year ?? null,
  title: s.title,
  source: s.source ?? null,
  publisher: s.publisher ?? null,
  volume: s.volume ?? null,
  issue: s.issue ?? null,
  pages: s.pages ?? null,
  doc_date: s.doc_date ?? null,
  doi: s.doi ?? null,
});

export async function applySuggestion(item: ItemRow, quiet = false): Promise<void> {
  const s = item.suggested;
  if (!s) return;
  const previous = fieldsOf(item);
  await update("items", item.id, { ...fieldsOf(s), suggested: { ...s, applied: true, previous } });
  if (!quiet) {
    showToast("Details updated.", { label: "Undo", run: () => update("items", item.id, { ...previous, suggested: { ...s, applied: false } }) });
  }
}

export type ReferenceFields = Partial<Record<"author" | "year" | "title" | "source" | "publisher" | "volume" | "issue" | "pages" | "doi", string>>;

// Reads what it can from a pasted reference or DOI. Only what is found is
// returned, so filling never blanks a field the reader has already typed.
// Dashes in page ranges are written as hyphens, whatever the source used.
export function parseReference(input: string): ReferenceFields {
  const found: ReferenceFields = {};
  let text = input.replace(/\s+/g, " ").trim();
  const doi = /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)\b/.exec(text);
  if (doi) {
    found.doi = doi[1];
    text = text.replace(/(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/i, " ");
  } else {
    const url = /https?:\/\/\S+/.exec(text);
    if (url) {
      found.doi = url[0].replace(/[.,;]+$/, "");
      text = text.replace(url[0], " ");
    }
  }
  const quoted = /(?<=^|[\s(\[,:;])(?:'(.+?)'|"(.+?)"|\u2018(.+?)\u2019|\u201c(.+?)\u201d)(?=[\s,.;:)\]]|$)/.exec(text);
  const year = /\b(1[5-9]\d{2}|20\d{2})\b/.exec(text);
  if (year) {
    found.year = year[1];
    const author = text.slice(0, year.index).replace(/[\s(,[]+$/, "").trim();
    if (author && (!quoted || quoted.index > year.index)) found.author = author;
  }
  // A page range marked with p. or pp. wins over any other pair of numbers.
  const pages = /\bpp?\.\s*(\d+\s*[-\u2013\u2014]\s*\d+)/i.exec(text) ?? /\b(?:pp?\.\s*)?(\d+\s*-\s*\d+)\b/i.exec(text);
  if (pages) found.pages = pages[1].replace(/\s*[-\u2013\u2014]\s*/, "-");
  const volume = /\b(\d+)\s*\((\d+)\)/.exec(text.replace(/\((1[5-9]\d{2}|20\d{2})\)/g, " "));
  if (volume) {
    found.volume = volume[1];
    found.issue = volume[2];
  }
  let rest = "";
  if (quoted) {
    found.title = (quoted[1] ?? quoted[2] ?? quoted[3] ?? quoted[4]).replace(/[,.]+$/, "").trim();
    rest = text.slice(quoted.index + quoted[0].length);
  } else if (year) {
    // Without quotation marks the title is taken as the sentence after the year.
    const after = text.slice(year.index + year[0].length).replace(/^[\s).,:]+/, "");
    const title = after.split(/\.\s/)[0].trim();
    if (title && !/^\d/.test(title)) {
      found.title = title.replace(/[.,]+$/, "");
      rest = after.slice(after.indexOf(title) + title.length);
    }
  }
  if (rest) {
    // The next phrase is the journal or book, cut before any volume number.
    const source = rest.replace(/^[\s.,:]+/, "").replace(/^In:?\s+/i, "").split(/,|\.\s|\s+\d/)[0].replace(/[.:]+$/, "").trim();
    // "London: Verso" is a place and publisher rather than a source.
    const imprint = /^[A-Z][A-Za-z .]+:\s*(.+)$/.exec(source);
    if (imprint && !quoted) found.publisher = imprint[1].trim();
    else if (source && !/^\d/.test(source) && !/^pp?\./i.test(source)) found.source = source;
  }
  return found;
}

export async function keepMine(item: ItemRow): Promise<void> {
  if (item.suggested) await update("items", item.id, { suggested: { ...item.suggested, dismissed: true } });
}

// Puts back the details a reading had before a citation was applied.
export async function putBack(item: ItemRow): Promise<void> {
  const s = item.suggested;
  if (!s?.previous) return;
  await update("items", item.id, { ...s.previous, suggested: { ...s, applied: false, dismissed: true } });
  showToast("The old details are back.");
}

export async function lookAgain(item: ItemRow): Promise<void> {
  if (!item.file_id) return;
  await api(`/api/files/${encodeURIComponent(item.file_id)}/identify`, { method: "POST" }).catch(() => undefined);
  showToast("Looking at the PDF again. Any change shows here in a minute or two.");
}

export type RedoStep = "ocr" | "thumb" | "identify";

const REDO_MESSAGES: Record<RedoStep, string> = {
  ocr: "Reading the text again. The updated pages will appear in a minute or two.",
  thumb: "Updating the cover thumbnail.",
  identify: "Looking at the PDF again for its details.",
};

// Asks for one step of a file's processing to be done again. The toast says
// what is now happening, or that the request never reached the server.
export async function redoFileStep(fileId: string, step: RedoStep): Promise<void> {
  try {
    await api(`/api/files/${encodeURIComponent(fileId)}/redo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step }),
    });
  } catch {
    showToast("That could not be started, so check the connection and try again.");
    return;
  }
  showToast(REDO_MESSAGES[step]);
}
