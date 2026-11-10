// WordCraft's embedded chrome as the word processor sees it: the room WordCraft
// keeps for our controls (patches/wordcraft-embedded-chrome.diff,
// crates/ui-egui/src/host_chrome.rs), the report host-bridge.js relays from
// its ui.hostChrome command, and where our two docks go in either build.
// Pure, so it can be tested without React.

/**
 * Room WordCraft keeps for our own controls in its embedded chrome, in CSS
 * pixels (patches/wordcraft-embedded-chrome.diff, host_chrome.rs). The tab
 * strip keeps room before Home for Back only, because every other control now
 * lives on the status bar, which keeps room before "Page x of y" for that bar;
 * its width is measured and sent as it changes, so these are only first guesses.
 */
export interface ChromeInsets { tabStart: number; tabEnd: number; status: number }
export const INSETS_REGULAR: ChromeInsets = { tabStart: 60, tabEnd: 0, status: 520 };
export const INSETS_COMPACT: ChromeInsets = { tabStart: 28, tabEnd: 0, status: 300 };
export const COMPACT_BELOW_PX = 640;

// WordCraft's own padding around the reserved room: the tab strip's 8 and 10
// point margins (ribbon.rs:155) and the status bar's 12 point margin
// (chrome.rs:705). A dock covers the margin and the room together.
export const STRIP_MARGIN_START = 8;
export const STRIP_MARGIN_END = 10;
export const STATUS_MARGIN_START = 12;

/**
 * A build without embedded chrome still draws its File tab at the start of the
 * 30px tab strip (once index.html has lifted the 38px title bar out of view),
 * so the Back dock covers this rectangle and host-bridge.js swallows any
 * pointer event inside it. Widen it here if a screenshot shows the File tab's
 * edge, since the editor URL passes the same values to the bridge.
 */
export const FILE_TAB_COVER = { width: 68, height: 30 } as const;
export const FALLBACK_STATUS_HEIGHT = 26;

/** Below this width the Back dock shows its arrow alone, because the label would be clipped. */
export const BACK_LABEL_MIN_WIDTH = 56;

/** What host-bridge.js reports from WordCraft's `ui.hostChrome` command. */
export interface ChromeInfo {
  embedded: boolean;
  tabStrip: { top: number; height: number; insetStart: number; insetEnd: number };
  statusBar: { height: number; insetStart: number };
  colours: Partial<Record<"tabStrip" | "statusBar" | "text" | "textDim" | "border" | "accent", string>>;
}

/**
 * Where our docks sit. The status dock either spans the whole native status
 * bar (a build that keeps no room, whose own bar we cover completely) or is
 * measured so that WordCraft keeps exactly its width (the embedded build).
 */
export interface DockGeometry {
  back: { top: number; width: number; height: number; iconOnly: boolean };
  status: { height: number; span: "full" | "measured" };
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

/**
 * Dock positions for a confirmed embedded build (chrome given) or for any other
 * build (chrome null), which is treated as one that still draws File and its
 * own full status bar, since index.html lifts its title bar from the start.
 */
export function dockGeometry(chrome: ChromeInfo | null): DockGeometry {
  if (chrome) {
    const width = STRIP_MARGIN_START + chrome.tabStrip.insetStart;
    return {
      back: {
        top: chrome.tabStrip.top,
        width,
        height: chrome.tabStrip.height,
        iconOnly: width < BACK_LABEL_MIN_WIDTH,
      },
      status: { height: chrome.statusBar.height, span: "measured" },
    };
  }
  return {
    back: { top: 0, width: FILE_TAB_COVER.width, height: FILE_TAB_COVER.height, iconOnly: false },
    status: { height: FALLBACK_STATUS_HEIGHT, span: "full" },
  };
}

/** The editor's query string, so the insets and the File guard reach the iframe together. */
export function editorQuery(insets: ChromeInsets): string {
  return (
    "host=parent&chrome=embedded" +
    `&tabInset=${insets.tabStart},${insets.tabEnd}&statusInset=${insets.status}` +
    `&fileGuard=${FILE_TAB_COVER.width},${FILE_TAB_COVER.height}`
  );
}
