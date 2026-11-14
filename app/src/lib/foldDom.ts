// Reading and setting whether a collapsible heading is open, in a way that
// survives BlockNote upgrades. 0.44, and some releases after it recorded it as
// data-show-children on .bn-toggle-wrapper; later releases record it as
// aria-expanded on .bn-toggle-button and keep the real state in a closure,
// so writing the attribute does nothing. Both releases remember it in
// localStorage under `toggle-<block id>`, and both toggle on a click of
// .bn-toggle-button, so clicking is the one way to change it everywhere.

export const FOLD_ATTRIBUTES = ["data-show-children", "aria-expanded"] as const;

export const foldKey = (blockId: string) => `toggle-${blockId}`;

export interface FoldParts {
  wrapper: HTMLElement | null;
  button: HTMLButtonElement | null;
}

export function foldParts(root: ParentNode, blockId: string): FoldParts {
  const outer = root.querySelector<HTMLElement>(`.bn-block-outer[data-id="${CSS.escape(blockId)}"]`);
  // Only the heading's own toggle, never one in a nested block beneath it.
  const content = outer?.querySelector<HTMLElement>(":scope > .bn-block > .bn-block-content");
  const wrapper = content?.querySelector<HTMLElement>(".bn-toggle-wrapper") ?? null;
  const button = wrapper?.querySelector<HTMLButtonElement>(".bn-toggle-button") ?? null;
  return { wrapper, button };
}

// Open unless the editor says otherwise; a heading with no toggle drawn yet counts as open.
export function readOpen({ wrapper, button }: FoldParts): boolean {
  const expanded = button?.getAttribute("aria-expanded");
  if (expanded === "true" || expanded === "false") return expanded === "true";
  const shown = wrapper?.getAttribute("data-show-children");
  return shown !== "false";
}

function stored(blockId: string): string | null {
  try { return localStorage.getItem(foldKey(blockId)); } catch { return "true"; /* private browsing: treat as known */ }
}

// A collapsible heading this device has never seen starts open, so turning a
// heading into one never makes the writing beneath it vanish. Returns whether
// the heading had to be opened.
export function openIfNew(parts: FoldParts, blockId: string): boolean {
  if (stored(blockId) !== null || !parts.button) return false;
  if (!readOpen(parts)) {
    parts.button.click(); // writes `toggle-<id>` = "true" itself
    return true;
  }
  try { localStorage.setItem(foldKey(blockId), "true"); } catch { /* private browsing */ }
  return false;
}

// Called before a heading becomes collapsible, so its toggle is created open.
export function rememberOpen(blockId: string): void {
  try {
    if (localStorage.getItem(foldKey(blockId)) === null) localStorage.setItem(foldKey(blockId), "true");
  } catch { /* private browsing */ }
}

// Opens a folded heading, as when the cursor lands inside its hidden section.
export function openFold(parts: FoldParts): boolean {
  if (!parts.button || readOpen(parts)) return false;
  parts.button.click();
  return true;
}
