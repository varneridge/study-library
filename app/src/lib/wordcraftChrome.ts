// WordCraft's embedded chrome as the word processor sees it: the room WordCraft
// keeps for our controls (patches/wordcraft-embedded-chrome.diff,
// crates/ui-egui/src/host_chrome.rs) and the report host-bridge.js relays from
// its ui.hostChrome command. Pure, so it can be tested without React.

/**
 * Room WordCraft keeps for our own controls in its embedded chrome, in CSS
 * pixels (patches/wordcraft-embedded-chrome.diff, host_chrome.rs). The tab
 * strip gets room before Home for Back, Undo and Redo and room after Comments
 * for the save state and Full screen; the status bar gets room before
 * "Page x of y" for our word count, whose width is measured and sent as it changes.
 */
export interface ChromeInsets { tabStart: number; tabEnd: number; status: number }
export const INSETS_REGULAR: ChromeInsets = { tabStart: 100, tabEnd: 116, status: 320 };
export const INSETS_COMPACT: ChromeInsets = { tabStart: 88, tabEnd: 44, status: 200 };
export const COMPACT_BELOW_PX = 640;

// WordCraft's own padding around the reserved room: the tab strip's 8 and 10
// point margins (ribbon.rs:155) and the status bar's 12 point margin
// (chrome.rs:705). A dock covers the margin and the room together.
export const STRIP_MARGIN_START = 8;
export const STRIP_MARGIN_END = 10;
export const STATUS_MARGIN_START = 12;

/** What host-bridge.js reports from WordCraft's `ui.hostChrome` command. */
export interface ChromeInfo {
  embedded: boolean;
  tabStrip: { top: number; height: number; insetStart: number; insetEnd: number };
  statusBar: { height: number; insetStart: number };
  colours: Partial<Record<"tabStrip" | "statusBar" | "text" | "textDim" | "border" | "accent", string>>;
}


const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const HEX = /^#[0-9a-f]{6}$/i;

/** A chrome report, checked: the iframe is same-origin, but its values still set our layout. */
export function parseChrome(value: unknown): ChromeInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, any>;
  if (r.embedded !== true) return null;
  const colours: ChromeInfo["colours"] = {};
  if (typeof r.colours === "object" && r.colours) {
    for (const k of ["tabStrip", "statusBar", "text", "textDim", "border", "accent"] as const) {
      if (typeof r.colours[k] === "string" && HEX.test(r.colours[k])) colours[k] = r.colours[k];
    }
  }
  return {
    embedded: true,
    tabStrip: {
      top: num(r.tabStrip?.top, 0),
      height: num(r.tabStrip?.height, 30),
      insetStart: num(r.tabStrip?.insetStart, 0),
      insetEnd: num(r.tabStrip?.insetEnd, 0),
    },
    statusBar: { height: num(r.statusBar?.height, 26), insetStart: num(r.statusBar?.insetStart, 0) },
    colours,
  };
}
