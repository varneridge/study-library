import type { ReadingView } from "./library";
import type { ItemKind } from "./types";

export const KIND_ORDER: readonly ItemKind[] = ["primary", "secondary", "summary", "slides"] as const;

export const KIND_GROUP_ORDER: readonly ("primary" | "secondary" | "summary")[] = [
  "primary",
  "secondary",
  "summary",
] as const;

export const KIND_LABEL: Record<ItemKind, string> = {
  primary: "primary reading",
  secondary: "secondary reading",
  summary: "summary",
  slides: "slides",
};

export const KIND_TITLE_LABEL: Record<ItemKind, string> = {
  primary: "Primary reading",
  secondary: "Secondary reading",
  summary: "Summary",
  slides: "Slides",
};

export const KIND_DELETE_LABEL: Record<ItemKind, string> = {
  primary: "Delete reading",
  secondary: "Delete reading",
  summary: "Delete summary",
  slides: "Delete slides",
};

export const KIND_GROUP: Record<"primary" | "secondary" | "summary", string> = {
  primary: "Primary readings",
  secondary: "Secondary readings",
  summary: "Summaries",
};

export const KIND_NOUN: Record<ItemKind, string> = {
  primary: "reading",
  secondary: "reading",
  summary: "summary",
  slides: "slides",
};

export const KIND_TOAST_DELETED: Record<ItemKind, string> = {
  primary: "Reading deleted.",
  secondary: "Reading deleted.",
  summary: "Summary deleted.",
  slides: "Slides deleted.",
};

export function deleteLabel(kind: ItemKind): string {
  return KIND_DELETE_LABEL[kind];
}

// A file counts as video by its MIME type alone, since a recording keeps its
// type whichever kind of reading it was filed under.
export function isVideoMime(mime?: string | null): boolean {
  return typeof mime === "string" && mime.trim().toLowerCase().startsWith("video/");
}

// How a reading is shown, which differs from its stored kind in one respect:
// a video is set apart from the texts whatever kind it was given, because it
// opens in its own player and cannot be read or highlighted like a text.
export type DisplayKind = ItemKind | "video" | "other";

// The groups a session lists beside its notes. Slides have no group, since
// the slide viewer shows them, so a stray deck falls in with other readings.
export type DisplayGroupKey = "primary" | "secondary" | "summary" | "video" | "other";

export const DISPLAY_GROUP_ORDER: readonly DisplayGroupKey[] = [
  "primary",
  "secondary",
  "summary",
  "video",
  "other",
] as const;

export const DISPLAY_GROUP_LABEL: Record<DisplayGroupKey, string> = {
  ...KIND_GROUP,
  video: "Videos",
  other: "Other readings",
};

const KNOWN_KINDS: ReadonlySet<string> = new Set(KIND_ORDER);

export function displayKind(view: Pick<ReadingView, "item" | "file" | "upload">): DisplayKind {
  if (isVideoMime(view.file?.mime ?? view.upload?.mime)) return "video";
  const kind = String(view.item.kind ?? "");
  return KNOWN_KINDS.has(kind) ? (kind as ItemKind) : "other";
}

function groupKey(kind: DisplayKind): DisplayGroupKey {
  return kind === "slides" ? "other" : kind;
}

// The readings set out by group in a fixed order, so primary readings,
// secondary readings, summaries and videos are told apart at a glance. Each
// group keeps the order it was given, and groups with nothing in them are left
// out so no heading stands over an empty list.
export function groupReadings<V extends Pick<ReadingView, "item" | "file" | "upload">>(
  views: readonly V[],
): { key: DisplayGroupKey; label: string; views: V[] }[] {
  const buckets = new Map<DisplayGroupKey, V[]>(DISPLAY_GROUP_ORDER.map((key) => [key, []]));
  for (const view of views) buckets.get(groupKey(displayKind(view)))!.push(view);
  return DISPLAY_GROUP_ORDER
    .map((key) => ({ key, label: DISPLAY_GROUP_LABEL[key], views: buckets.get(key)! }))
    .filter((group) => group.views.length > 0);
}
