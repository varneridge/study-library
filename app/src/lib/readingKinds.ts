// A week's readings in three groups: primary readings, secondary readings and
// summaries. The group is the item's own kind, so a reading moved from one
// group to another moves in every week that lists it.

export const READING_KINDS = ["primary", "secondary", "summary"] as const;
export type ReadingKind = (typeof READING_KINDS)[number];

export function isReadingKind(kind: unknown): kind is ReadingKind {
  return typeof kind === "string" && (READING_KINDS as readonly string[]).includes(kind);
}

// The drop zone names WeekPage's targetOf already understands
// (WeekPage.tsx:150-152): secondary readings keep their historic "readings".
export const DROP_ZONE: Record<ReadingKind, "primary" | "readings" | "summary"> = {
  primary: "primary",
  secondary: "readings",
  summary: "summary",
};

export interface KindGroup<V> {
  kind: ReadingKind;
  views: V[];
}

// Always three groups in a fixed order, empty ones included, so each has a
// heading and somewhere to drop files. Anything of another kind (slides,
// for instance) is left to its own place on the page.
export function groupByKind<V>(views: readonly V[], kindOf: (view: V) => unknown): KindGroup<V>[] {
  return READING_KINDS.map((kind) => ({ kind, views: views.filter((v) => kindOf(v) === kind) }));
}

export interface KindMenuItem {
  label: string;
  onSelect: () => void;
  hidden?: boolean;
}

// The item menu's "Move to …" choices: the two groups the item is not in.
// Items of any other kind get none, so slides are never turned into readings.
export function kindMenuItems(
  current: unknown,
  labels: Record<ReadingKind, string>,
  setKind: (kind: ReadingKind) => void,
): KindMenuItem[] {
  if (!isReadingKind(current)) return [];
  return READING_KINDS.filter((k) => k !== current).map((kind) => ({
    label: `Move to ${labels[kind].toLowerCase()}`,
    onSelect: () => setKind(kind),
  }));
}
