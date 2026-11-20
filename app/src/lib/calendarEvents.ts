// Reading the calendar's events from the database: every source gathered into
// the one CalEvent shape for the dates a view shows, and a single event found
// by the key its link carries, so that a link to an event outside the dates on
// screen still opens it.

import { useLiveQuery } from "dexie-react-hooks";
import { useRef } from "react";
import {
  type CalEvent,
  type CalendarSource,
  buildApplicationEvent,
  buildGcalEvent,
  buildModuleKeyEvent,
  buildPersonalEvent,
  buildProspectEvent,
  buildTaskEvent,
  overlaps,
} from "./calendar";
import { type ISODate, addDays } from "./civilDate";
import { db } from "./db";
import type { CalendarEventRow } from "./types";

// Every event that touches from to to, inclusive, from the sources not hidden.
// A hidden source is not read at all.
export async function loadCalendarEvents(from: ISODate, to: ISODate, hidden: readonly CalendarSource[]): Promise<CalEvent[]> {
  const shown = (source: CalendarSource) => !hidden.includes(source);
  const [personal, google, applications, prospects, modules, tasks] = await Promise.all([
    shown("personal") ? db.calendar_events.where("start_date").belowOrEqual(to).toArray() : [],
    shown("google") ? db.gcal_events.where("start_date").belowOrEqual(to).toArray() : [],
    shown("deadline") ? db.applications.toArray() : [],
    shown("check") ? db.prospects.where("next_check").between(from, addDays(to, 1), true, false).toArray() : [],
    shown("essay") ? db.modules.toArray() : [],
    shown("tasks") ? db.tasks.where("due_date").between(from, addDays(to, 1), true, false).toArray() : [],
  ]);
  const events: (CalEvent | null)[] = [
    ...personal.map(buildPersonalEvent),
    ...google.map(buildGcalEvent),
    ...applications.map(buildApplicationEvent),
    ...prospects.map(buildProspectEvent),
    ...tasks.map(buildTaskEvent),
    ...modules.flatMap((m) => (Array.isArray(m.key_dates) ? m.key_dates : []).map((k) => buildModuleKeyEvent(m, k))),
  ];
  return events.filter((e): e is CalEvent => e !== null && overlaps(e, from, to));
}

// The same, kept up to date as the data changes. The last answer stays on
// screen while the next is read, so that moving between months never blanks.
export function useCalendarEvents(from: ISODate, to: ISODate, hidden: readonly CalendarSource[]): CalEvent[] | undefined {
  const hiddenKey = hidden.join(",");
  const last = useRef<CalEvent[] | undefined>(undefined);
  const live = useLiveQuery(
    () => loadCalendarEvents(from, to, hiddenKey ? (hiddenKey.split(",") as CalendarSource[]) : []),
    [from, to, hiddenKey],
  );
  if (live) last.current = live;
  return live ?? last.current;
}

// What the event sheet is for: a new event, one of your own to edit, a Google
// event to read, or a link to something that is gone.
export type SheetTarget =
  | { kind: "new" }
  | { kind: "personal"; row: CalendarEventRow }
  | { kind: "google"; event: CalEvent }
  | { kind: "missing" };

export async function resolveSheetTarget(key: string): Promise<SheetTarget> {
  if (key === "new") return { kind: "new" };
  if (key.startsWith("p:")) {
    const row = await db.calendar_events.get(key.slice(2));
    return row && !row.deleted ? { kind: "personal", row } : { kind: "missing" };
  }
  if (key.startsWith("g:")) {
    const row = await db.gcal_events.get(key.slice(2));
    const event = row ? buildGcalEvent(row) : null;
    return event ? { kind: "google", event } : { kind: "missing" };
  }
  return { kind: "missing" };
}

// Undefined only while the first answer is being read.
export function useSheetTarget(key: string): SheetTarget | undefined {
  return useLiveQuery(() => resolveSheetTarget(key), [key]);
}
