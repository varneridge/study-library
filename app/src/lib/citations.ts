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
    default: return "from the PDF";
  }
}

export function pending(item: ItemRow): Suggestion | null {
  const s = item.suggested;
  return s && !s.applied && !s.dismissed ? s : null;
}

const fieldsOf = (s: Suggestion) => ({ author: s.author, year: s.year, title: s.title, source: s.source, pages: s.pages });

export async function applySuggestion(item: ItemRow): Promise<void> {
  const s = item.suggested;
  if (!s) return;
  const previous = { author: item.author, year: item.year, title: item.title, source: item.source, pages: item.pages };
  await update("items", item.id, { ...fieldsOf(s), suggested: { ...s, applied: true, previous } });
  showToast("Details updated.", { label: "Undo", run: () => update("items", item.id, { ...previous, suggested: { ...s, applied: false } }) });
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
