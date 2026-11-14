// Decisions behind one-step highlighting: which keystrokes the reader may
// claim, and when a new selection would only duplicate a highlight that is
// already there. Kept free of the DOM where possible so it can be tested.

export interface HighlightLike {
  id: string;
  page: number;
  body: string | null;
  deleted?: boolean | number | null;
}

export interface Capture {
  page: number;
  body: string;
}

// Collapses whitespace and the soft hyphens and line-break hyphenation that
// PDF text layers produce, so the same words selected twice compare equal.
export function normaliseBody(text: string): string {
  return text
    .replace(/\u00ad/gu, "")
    .replace(/(\p{L})-\s*\n\s*(\p{L})/gu, "$1$2")
    .replace(/\s+/gu, " ")
    .trim();
}

// A capture duplicates an existing highlight when it is on the same page and
// its normalised text is equal to, or wholly inside, that highlight's text.
export function isDuplicate(existing: readonly HighlightLike[], capture: Capture): boolean {
  const body = normaliseBody(capture.body);
  if (body === "") return true;
  return existing.some((h) => !h.deleted && h.page === capture.page && normaliseBody(h.body ?? "").includes(body));
}

// Whether a captured selection is worth offering to highlight at all: it
// must contain at least one letter or digit, which excludes stray spaces.
export function isHighlightable(capture: Capture): boolean {
  return /[\p{L}\p{N}]/u.test(capture.body);
}

export type ShortcutAction = "highlight" | "comment" | "dismiss" | null;

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

// The reader's selection shortcuts, which apply only while a selection bar is
// showing and focus is not in something editable. Auto-repeat is ignored so
// that holding H cannot create a run of highlights.
export function shortcutFor(e: KeyLike, focusEditable: boolean, barOpen: boolean): ShortcutAction {
  if (!barOpen || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === "Escape") return "dismiss";
  if (focusEditable) return null;
  const k = e.key.toLowerCase();
  if (k === "h") return "highlight";
  if (k === "c") return "comment";
  return null;
}
