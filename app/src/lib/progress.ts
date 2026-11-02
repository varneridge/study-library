// Reading counts and module progress.
// Only primary and secondary readings are ever ticked or counted towards
// progress. Slides and summaries are kept to hand, not read through.

import type { ItemRow, WeekRow } from "./types";
import type { TeachingWeek, TermDates } from "./term";
import { weekDates } from "./term";
import { shortDate } from "./dates";

// Only primary and secondary readings are ever ticked or counted.
export function counts(item: { kind: string; deleted?: number | boolean }): boolean {
  if (item.deleted) return false;
  return item.kind === "primary" || item.kind === "secondary";
}

// Used by @ autocomplete in notes and Copy reference in row menus.
export function citable(item: { kind: string; deleted?: number | boolean }): boolean {
  if (item.deleted) return false;
  return item.kind === "primary" || item.kind === "secondary";
}

// A week's count: its live, loose primary and secondary readings.
export function readCount(items: (ItemRow | { item: ItemRow })[]): { read: number; total: number } {
  let read = 0;
  let total = 0;
  for (const entry of items) {
    const item = "item" in entry ? entry.item : entry;
    if (counts(item)) {
      total += 1;
      if (item.read_status === "read") {
        read += 1;
      }
    }
  }
  return { read, total };
}

export type ModuleProgress =
  | { state: "week"; week: WeekRow; read: number; total: number }
  | { state: "reading-week"; week: WeekRow; read: number; total: number }
  | { state: "upcoming"; week: WeekRow; read: number; total: number }
  | { state: "none" };

export function moduleProgress(
  weeks: { week: WeekRow; items: ItemRow[] }[],
  now: TeachingWeek | null,
): ModuleProgress {
  if (!now) return { state: "none" };

  const entry = weeks.find(
    (w) => !w.week.deleted && w.week.term === now.term && w.week.number === now.number,
  );
  if (!entry) return { state: "none" };

  const { read, total } = readCount(entry.items);
  if (now.upcoming) {
    return { state: "upcoming", week: entry.week, read, total };
  }
  if (entry.week.is_reading_week) {
    return { state: "reading-week", week: entry.week, read, total };
  }
  return { state: "week", week: entry.week, read, total };
}

export function progressWords(progress: ModuleProgress, dates?: TermDates): string {
  if (progress.state === "none") return "";
  const code = `${progress.week.term}${progress.week.number}`;
  const { read, total } = progress;

  if (progress.state === "upcoming") {
    const startDate = dates ? weekDates(progress.week.term, progress.week.number, dates)?.start : null;
    const dateStr = startDate ? shortDate(startDate, { utc: true }) : null;
    const prefix = dateStr ? `${code} starts ${dateStr}` : `${code} upcoming`;
    const countStr = total === 0 ? "no readings" : `${read} of ${total} read`;
    return `${prefix}: ${countStr}`;
  }

  const countStr =
    total === 0
      ? "no readings"
      : read === 0
        ? total === 1
          ? "1 reading"
          : `${total} readings`
        : read === total
          ? `all ${total} read`
          : `${read} of ${total} read`;

  if (progress.state === "reading-week") {
    return total > 0 ? `${code}: reading week (${countStr})` : `${code}: reading week`;
  }

  return `${code}: ${countStr}`;
}
