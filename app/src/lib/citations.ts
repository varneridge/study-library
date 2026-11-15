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
