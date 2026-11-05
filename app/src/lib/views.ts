// How a folder's readings are laid out, as File Explorer lays out files:
// compact rows, normal rows with a larger picture, icons, or large icons.
// Each week, section and shelf remembers its own choice, on every device.

import type { ReadingView } from "./library";
import { isVideoMime } from "./video";

export type ReadingViewMode = "compact" | "normal" | "icons" | "large";

export const VIEW_MODES: readonly { value: ReadingViewMode; label: string; icon: string }[] = [
  { value: "compact", label: "Compact", icon: "viewCompact" },
  { value: "normal", label: "Normal", icon: "viewNormal" },
  { value: "icons", label: "Icons", icon: "viewIcons" },
  { value: "large", label: "Large icons", icon: "viewLarge" },
];

// Icons and large icons lay readings out as tiles in a grid; the others as rows.
export function isTileMode(mode: ReadingViewMode): boolean {
  return mode === "icons" || mode === "large";
}

// The synced setting that holds a folder's choice.
export function viewSettingKey(folderId: string): string {
  return `view:${folderId}`;
}

// A stored choice, if it is one this version knows.
export function parseViewMode(value: unknown): ReadingViewMode | null {
  return VIEW_MODES.some((m) => m.value === value) ? (value as ReadingViewMode) : null;
}

type Shown = Pick<ReadingView, "file" | "upload">;

export function isVideoView(view: Shown): boolean {
  return isVideoMime(view.file?.mime ?? view.upload?.mime);
}

// Until a choice is made: a folder of videos opens as large icons, so each
// frame and its play button can be seen, a shelf of books opens as icons,
// a little smaller than the week cards, and a week's readings as compact rows.
export function defaultViewMode({ library, views }: { library: boolean; views: Shown[] }): ReadingViewMode {
  if (views.length > 0 && views.every(isVideoView)) return "large";
  return library ? "icons" : "compact";
}

// Videos and slides are landscape pictures; everything else is a page.
export function coverShape(view: Shown & Pick<ReadingView, "item">): "wide" | "page" {
  return isVideoView(view) || view.item.kind === "slides" ? "wide" : "page";
}
