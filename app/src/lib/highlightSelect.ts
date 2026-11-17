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

export interface EdgesLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// Whether a rectangle read from the page can place anything. A range in text
// that is hidden, or not yet laid out, reports a rectangle of zeros, and
// placing the selection bar against that sends it to the corner of the screen.
export function usableRect<T extends EdgesLike>(rect: T | null | undefined): rect is T {
  if (!rect) return false;
  const { left, top, right, bottom } = rect;
  if (![left, top, right, bottom].every(Number.isFinite)) return false;
  return right - left > 0 || bottom - top > 0;
}

export interface SelectionLike {
  page: number;
  text: string;
  rects: readonly (readonly number[])[];
  x: number;
  y: number;
}

// A key that is equal for two reports of the same selection in the same
// place. Browsers fire selectionchange when nothing visible has changed, and
// passing each of those on re-rendered and re-placed the selection bar, so
// the reader compares keys and only reports a selection that really changed.
export function selectionKey(s: SelectionLike): string {
  const rects = s.rects.map((r) => r.map((n) => Math.round(n * 10) / 10).join(",")).join(";");
  return `${s.page}|${normaliseBody(s.text)}|${rects}|${Math.round(s.x)}|${Math.round(s.y)}`;
}
