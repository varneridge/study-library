// Which essays cite a reading's highlights, worked out from the essays' own settings rows,
// so that a highlight's card can say so before it is deleted. Kept free of the database so
// it can be tested; useHighlightReferences in assessment.ts runs it against live rows.

import { normaliseSourceLinks } from "./essaySources";
import type { HighlightRow, ModuleRow } from "./types";

export interface HighlightReference {
  moduleId: string;
  essayId: string;
  essayTitle: string;
}

export interface EssaySettingRow {
  id: string;
  value: unknown;
  deleted?: boolean;
}

const PREFIX = "assessment:";

// An essay's module and id from its row's key: "assessment:<module>" is the module's
// first essay and "assessment:<module>:<essay>" any other, as assessmentSettingKey makes them.
export function essayKeyParts(key: string): { moduleId: string; essayId: string } | null {
  if (!key.startsWith(PREFIX)) return null;
  const [moduleId, essayId] = key.slice(PREFIX.length).split(":");
  return moduleId ? { moduleId, essayId: essayId || "default" } : null;
}

// The title an essay is shown by, as its card on the module page shows it.
function essayTitleOf(value: Record<string, unknown>, module: Pick<ModuleRow, "code">): string {
  const own = typeof value.title === "string" ? value.title.trim() : "";
  return own || (module.code ? `${module.code} Essay` : "Essay");
}

// For each highlight of the reading, the essays whose references draw on it, each essay
// once, in the order the rows come. An essay whose row or module has been deleted is left
// out, since nothing there can still be broken by deleting the highlight.
export function referencesByHighlight(
  rows: readonly EssaySettingRow[],
  modules: readonly Pick<ModuleRow, "id" | "code" | "deleted">[],
  itemId: string,
): Map<string, HighlightReference[]> {
  const moduleById = new Map(modules.map((m) => [m.id, m] as const));
  const out = new Map<string, HighlightReference[]>();
  for (const row of rows) {
    if (row.deleted) continue;
    const parts = essayKeyParts(row.id);
    const module = parts ? moduleById.get(parts.moduleId) : undefined;
    if (!parts || !module || module.deleted) continue;
    if (!row.value || typeof row.value !== "object") continue;
    const value = row.value as Record<string, unknown>;
    const links = normaliseSourceLinks(value.sourceLinks);
    let title: string | null = null;
    for (const link of links) {
      if (link.sourceId !== itemId || !link.highlightId) continue;
      const list = out.get(link.highlightId) ?? [];
      if (list.some((ref) => ref.moduleId === parts.moduleId && ref.essayId === parts.essayId)) continue;
      title ??= essayTitleOf(value, module);
      list.push({ moduleId: parts.moduleId, essayId: parts.essayId, essayTitle: title });
      out.set(link.highlightId, list);
    }
  }
  return out;
}

// The line a highlight's card shows, such as "Referenced in \u201cWar and memory\u201d" or
// "Referenced in \u201cA\u201d, \u201cB\u201d and \u201cC\u201d", or null when no essay uses it.
export function referencedInLabel(refs: readonly HighlightReference[] | undefined): string | null {
  if (!refs?.length) return null;
  const titles = refs.map((ref) => `\u201c${ref.essayTitle}\u201d`);
  const joined = titles.length === 1 ? titles[0] : `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
  return `Referenced in ${joined}`;
}

// The highlights in reading order: by page, then from the top of the page down. A PDF's
// y runs up the page, so the higher top edge comes first.
export function inReadingOrder<T extends Pick<HighlightRow, "page" | "rects">>(rows: readonly T[]): T[] {
  const top = (row: T) => (row.rects.length ? Math.max(...row.rects.map((r) => Math.max(r[1], r[3]))) : 0);
  return [...rows].sort((a, b) => a.page - b.page || top(b) - top(a));
}
