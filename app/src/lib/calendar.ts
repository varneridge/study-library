// The calendar's pure logic: one event shape for every source, the range each
// view shows, how timed events share a day's columns, and what a valid new
// event needs. Nothing here touches the database, the network or the clock,
// so all of it can be tested without a browser.

import {
  type ISODate,
  addDays,
  addMonths,
  formatISO,
  formatLong,
  monthGrid,
  parseISO,
  weekdayMon0,
} from "./civilDate";
import type { GcalEvent } from "./db";
import type { Route } from "./router";
import type { ApplicationRow, CalendarEventRow, EventCategory, KeyDate, ModuleRow, ProspectRow, TaskRow } from "./types";

export type { EventCategory };

export type CalendarSource = "google" | "deadline" | "check" | "essay" | "personal" | "tasks";
export const CALENDAR_SOURCES: readonly CalendarSource[] = ["personal", "google", "deadline", "check", "essay", "tasks"];

export const EVENT_CATEGORIES: readonly EventCategory[] = ["appointment", "lecture", "reminder", "other"];

export type CalendarMode = "month" | "week" | "day" | "agenda";

// A wall clock time, "00:00" to "23:59", always zero padded.
export type HHMM = string;

export interface CalEvent {
  // Unique across sources: p:, g:, d:, c:, e: or t: followed by the source's id.
  key: string;
  source: CalendarSource;
  title: string;
  startDate: ISODate;
  // Inclusive, so a one day event has endDate equal to startDate.
  endDate: ISODate;
  // Both null exactly when allDay.
  startTime: HHMM | null;
  endTime: HHMM | null;
  allDay: boolean;
  category?: EventCategory;
  location?: string | null;
  notes?: string | null;
  // Where a deadline, a check or a key date leads when pressed.
  to?: Route;
  // Only your own events can be changed here.
  editable: boolean;
}

// The calendar's settings, kept in the synced settings table under one id.
export interface CalendarSettings {
  icsUrl: string | null;
  hidden: CalendarSource[];
}

export const CALENDAR_SETTINGS_ID = "calendar";

// Reads a settings value written by any version of the app, or by none, so a
// missing or malformed row gives the defaults rather than an error.
export function readCalendarSettings(value: unknown): CalendarSettings {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const url = typeof v.icsUrl === "string" ? v.icsUrl.trim() : "";
  const hidden = Array.isArray(v.hidden)
    ? CALENDAR_SOURCES.filter((source) => (v.hidden as unknown[]).includes(source))
    : [];
  return { icsUrl: url || null, hidden };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MINUTES = 24 * 60;
// The shortest a timed event is drawn, so that it can still be pressed.
export const MIN_EVENT_MINUTES = 15;
// The agenda reads this many days at a time, and Show later adds this many more.
export const AGENDA_DAYS = 60;

export function isHHMM(value: unknown): value is HHMM {
  return typeof value === "string" && HHMM_RE.test(value);
}

// Minutes since midnight, or NaN for anything that is not a valid time.
export function minutesOf(t: HHMM): number {
  const m = HHMM_RE.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

export function hhmm(minutes: number): HHMM {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function startOfWeek(iso: ISODate): ISODate {
  return addDays(iso, -weekdayMon0(iso));
}

// The dates a view covers, inclusive at both ends. A month covers all 42
// cells of its grid, so events on the leading and trailing days show too.
export function rangeFor(mode: CalendarMode, anchor: ISODate): { from: ISODate; to: ISODate } {
  switch (mode) {
    case "month": {
      const p = parseISO(anchor);
      if (!p) return { from: anchor, to: anchor };
      const grid = monthGrid(p.year, p.month);
      return { from: grid[0].iso, to: grid[grid.length - 1].iso };
    }
    case "week": {
      const from = startOfWeek(anchor);
      return { from, to: addDays(from, 6) };
    }
    case "day":
      return { from: anchor, to: anchor };
    case "agenda":
      return { from: anchor, to: addDays(anchor, AGENDA_DAYS - 1) };
  }
}

// The anchor one view earlier or later. A month keeps its day where it can,
// so 31 January steps to 28 February rather than into March.
export function stepAnchor(mode: CalendarMode, anchor: ISODate, dir: -1 | 1): ISODate {
  switch (mode) {
    case "month": return addMonths(anchor, dir);
    case "week": return addDays(anchor, 7 * dir);
    case "day": return addDays(anchor, dir);
    case "agenda": return addDays(anchor, AGENDA_DAYS * dir);
  }
}

// The heading above a view: "November 2026", "16 to 22 November 2026",
// "30 November to 6 December 2026", the full date, or "From ..." for the agenda.
export function titleFor(mode: CalendarMode, anchor: ISODate): string {
  const p = parseISO(anchor);
  if (!p) return "";
  switch (mode) {
    case "month":
      return `${MONTH_NAMES[p.month - 1]} ${p.year}`;
    case "week": {
      const a = parseISO(startOfWeek(anchor));
      const b = parseISO(addDays(startOfWeek(anchor), 6));
      if (!a || !b) return "";
      if (a.year !== b.year) {
        return `${a.day} ${MONTH_NAMES[a.month - 1]} ${a.year} to ${b.day} ${MONTH_NAMES[b.month - 1]} ${b.year}`;
      }
      if (a.month !== b.month) {
        return `${a.day} ${MONTH_NAMES[a.month - 1]} to ${b.day} ${MONTH_NAMES[b.month - 1]} ${b.year}`;
      }
      return `${a.day} to ${b.day} ${MONTH_NAMES[b.month - 1]} ${b.year}`;
    }
    case "day":
      return formatLong(anchor);
    case "agenda":
      return `From ${formatLong(anchor)}`;
  }
}

export function defaultMode(isPhone: boolean): CalendarMode {
  return isPhone ? "agenda" : "month";
}

export function overlaps(e: CalEvent, from: ISODate, to: ISODate): boolean {
  return e.startDate <= to && e.endDate >= from;
}

// The time an event begins on a given day: midnight when it began earlier.
function startOn(e: CalEvent, day: ISODate): number {
  return e.startDate < day ? 0 : minutesOf(e.startTime ?? "00:00");
}

// A day's events: those lasting all day first, then by start, then by title.
export function eventsOnDay(events: CalEvent[], day: ISODate): CalEvent[] {
  return events
    .filter((e) => overlaps(e, day, day))
    .sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      if (!a.allDay) {
        const diff = startOn(a, day) - startOn(b, day);
        if (diff) return diff;
      }
      return a.title.localeCompare(b.title, "en-GB") || a.key.localeCompare(b.key);
    });
}

export interface Placed {
  event: CalEvent;
  // Minutes from midnight, and the drawn length in minutes.
  top: number;
  height: number;
  // The column this event takes, and how many its cluster needs.
  col: number;
  cols: number;
}

// Places a day's timed events in columns so that none overlap. Events whose
// times chain together form a cluster that shares one column count; each
// event takes the lowest column free when it starts. An event running on
// from yesterday or into tomorrow is clipped to this day.
export function layoutDay(events: CalEvent[], day: ISODate): Placed[] {
  const spans = events
    .filter((e) => !e.allDay && overlaps(e, day, day))
    .map((event) => {
      let top = startOn(event, day);
      let end = event.endDate > day ? DAY_MINUTES : minutesOf(event.endTime ?? "23:59");
      if (end - top < MIN_EVENT_MINUTES) end = top + MIN_EVENT_MINUTES;
      if (end > DAY_MINUTES) {
        end = DAY_MINUTES;
        top = Math.min(top, DAY_MINUTES - MIN_EVENT_MINUTES);
      }
      return { event, top, end };
    })
    .sort((a, b) => a.top - b.top || b.end - a.end || a.event.key.localeCompare(b.event.key));

  const placed: Placed[] = [];
  let cluster: Placed[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -1;
  const closeCluster = () => {
    for (const p of cluster) p.cols = columnEnds.length;
    cluster = [];
    columnEnds = [];
  };

  for (const span of spans) {
    if (span.top >= clusterEnd) closeCluster();
    let col = columnEnds.findIndex((end) => end <= span.top);
    if (col === -1) {
      col = columnEnds.length;
      columnEnds.push(span.end);
    } else {
      columnEnds[col] = span.end;
    }
    const p: Placed = { event: span.event, top: span.top, height: span.end - span.top, col, cols: 1 };
    cluster.push(p);
    placed.push(p);
    clusterEnd = Math.max(clusterEnd, span.end);
  }
  closeCluster();
  return placed;
}

// Puts any event's dates and times into the shape CalEvent promises, or
// gives null when even its start date is unusable. A timed event shorter
// than the minimum is lengthened, carrying into the next day if it must, and
// one ending at midnight ends at 23:59 the day before, so it never leaves an
// empty sliver on the following day.
function normalise(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  startTime: string | null | undefined,
  endTime: string | null | undefined,
  allDay: boolean,
): Pick<CalEvent, "startDate" | "endDate" | "startTime" | "endTime" | "allDay"> | null {
  const start = startDate ? startDate.slice(0, 10) : "";
  if (!parseISO(start)) return null;
  let end = endDate ? endDate.slice(0, 10) : "";
  if (!parseISO(end) || end < start) end = start;

  if (allDay || !isHHMM(startTime)) {
    return { startDate: start, endDate: end, startTime: null, endTime: null, allDay: true };
  }
  const s = minutesOf(startTime);
  let e = isHHMM(endTime) ? minutesOf(endTime) : s + 60;
  if (!isHHMM(endTime) && e >= DAY_MINUTES) {
    e -= DAY_MINUTES;
    end = addDays(end, 1);
  }
  if (end === start && e - s < MIN_EVENT_MINUTES) {
    e = s + MIN_EVENT_MINUTES;
    if (e >= DAY_MINUTES) {
      e -= DAY_MINUTES;
      end = addDays(start, 1);
    }
  }
  if (e === 0 && end > start) {
    end = addDays(end, -1);
    e = DAY_MINUTES - 1;
  }
  return { startDate: start, endDate: end, startTime: hhmm(s), endTime: hhmm(e), allDay: false };
}

function joinTitle(prefix: string, parts: (string | null | undefined)[], fallback: string): string {
  const named = parts.map((p) => (p ?? "").trim()).filter(Boolean).join(", ");
  return named ? `${prefix}: ${named}` : fallback;
}

function categoryOf(value: unknown): EventCategory {
  return EVENT_CATEGORIES.includes(value as EventCategory) ? (value as EventCategory) : "other";
}

export function buildPersonalEvent(row: CalendarEventRow): CalEvent | null {
  if (row.deleted) return null;
  const when = normalise(row.start_date, row.end_date, row.start_time, row.end_time, row.all_day);
  if (!when) return null;
  return {
    key: `p:${row.id}`,
    source: "personal",
    title: row.title?.trim() || "Untitled event",
    ...when,
    category: categoryOf(row.category),
    location: row.location ?? null,
    notes: row.notes ?? null,
    editable: true,
  };
}

export function buildGcalEvent(row: GcalEvent): CalEvent | null {
  const when = normalise(row.start_date, row.end_date, row.start_time, row.end_time, row.all_day);
  if (!when) return null;
  return {
    key: `g:${row.key}`,
    source: "google",
    title: row.title?.trim() || "Untitled event",
    ...when,
    location: row.location ?? null,
    notes: row.notes ?? null,
    editable: false,
  };
}

export function buildApplicationEvent(row: ApplicationRow): CalEvent | null {
  if (row.deleted || !row.next_deadline) return null;
  const when = normalise(row.next_deadline, null, null, null, true);
  if (!when) return null;
  return {
    key: `d:${row.id}`,
    source: "deadline",
    title: joinTitle("Deadline", [row.employer, row.role], "Application deadline"),
    ...when,
    to: { view: "jobs", app: row.id },
    editable: false,
  };
}

export function buildProspectEvent(row: ProspectRow): CalEvent | null {
  if (row.deleted || !row.next_check) return null;
  const when = normalise(row.next_check, null, null, null, true);
  if (!when) return null;
  return {
    key: `c:${row.id}`,
    source: "check",
    title: joinTitle("Check", [row.employer, row.programme], "Check a prospect"),
    ...when,
    to: { view: "jobs", prospect: row.id },
    editable: false,
  };
}

// An open task with a due date. A due time makes it a short timed event, and
// without one it lasts the day. Pressing it opens the task on the to-do page.
export function buildTaskEvent(row: TaskRow): CalEvent | null {
  if (row.deleted || row.completed_at || !row.due_date) return null;
  const when = normalise(row.due_date, null, row.due_time, row.due_time, !row.due_time);
  if (!when) return null;
  return {
    key: `t:${row.id}`,
    source: "tasks",
    title: row.title?.trim() || "Untitled task",
    ...when,
    notes: row.notes ?? null,
    to: { view: "tasks", list: row.list_id, task: row.id },
    editable: false,
  };
}

export function buildModuleKeyEvent(module: ModuleRow, keyDate: KeyDate): CalEvent | null {
  if (module.deleted) return null;
  const when = normalise(keyDate.date, null, null, null, true);
  if (!when) return null;
  const label = keyDate.label?.trim() || "Key date";
  const code = module.code?.trim();
  return {
    key: `e:${module.id}:${keyDate.id}`,
    source: "essay",
    title: code ? `${code}: ${label}` : label,
    ...when,
    to: { view: "assessment", id: module.id },
    editable: false,
  };
}

// What the event sheet holds while you edit it.
export interface EventDraft {
  title: string;
  startDate: ISODate;
  endDate: ISODate;
  startTime: HHMM | null;
  endTime: HHMM | null;
  allDay: boolean;
  category: EventCategory;
  location: string;
  notes: string;
}

export type DraftError = "title" | "bad_date" | "bad_time" | "end_before_start";

export const DRAFT_ERROR_TEXT: Record<DraftError, string> = {
  title: "Add a title so you can find this later.",
  bad_date: "Choose a real date for the start and the end.",
  bad_time: "Choose a start and an end time, or make this an all day event.",
  end_before_start: "The end needs to come after the start.",
};

// The first problem with a draft, or null when it can be saved. Times are
// ignored for an all day event, so switching all day on and off again keeps
// the times you had chosen.
export function validateDraft(d: EventDraft): DraftError | null {
  if (!d.title.trim()) return "title";
  if (!parseISO(d.startDate) || !parseISO(d.endDate)) return "bad_date";
  if (d.allDay) return d.endDate < d.startDate ? "end_before_start" : null;
  if (!isHHMM(d.startTime) || !isHHMM(d.endTime)) return "bad_time";
  const start = `${d.startDate}T${d.startTime}`;
  const end = `${d.endDate}T${d.endTime}`;
  return end <= start ? "end_before_start" : null;
}

// The columns a valid draft saves, with the title and text trimmed and the
// times cleared for an all day event.
export function draftColumns(d: EventDraft): Omit<CalendarEventRow, "id" | "modified_at" | "seq" | "deleted"> {
  return {
    title: d.title.trim(),
    start_date: d.startDate,
    end_date: d.endDate,
    start_time: d.allDay ? null : d.startTime,
    end_time: d.allDay ? null : d.endTime,
    all_day: d.allDay,
    category: categoryOf(d.category),
    location: d.location.trim() || null,
    notes: d.notes.trim() || null,
  };
}

// What each source is called in the lists of calendars, and in short beside an
// event, so that its colour is never the only thing that tells it apart.
export const SOURCE_LABELS: Record<CalendarSource, string> = {
  personal: "Personal",
  google: "Google Calendar",
  deadline: "Job deadlines",
  check: "Job checks",
  essay: "Essay deadlines",
  tasks: "To do",
};

export const SOURCE_BADGES: Record<CalendarSource, string> = {
  personal: "Personal",
  google: "Google",
  deadline: "Deadline",
  check: "Check",
  essay: "Essay",
  tasks: "To do",
};

export const CATEGORY_LABELS: Record<EventCategory, string> = {
  appointment: "Appointment",
  lecture: "Lecture",
  reminder: "Reminder",
  other: "Other",
};

// When an event is, in words: "Monday 16 November 2026, 10:00 to 11:00".
export function describeWhen(e: Pick<CalEvent, "startDate" | "endDate" | "startTime" | "endTime" | "allDay">): string {
  const start = formatLong(e.startDate);
  const end = formatLong(e.endDate);
  if (e.allDay) return e.startDate === e.endDate ? `${start}, all day` : `${start} to ${end}, all day`;
  if (e.startDate === e.endDate) return `${start}, ${e.startTime} to ${e.endTime}`;
  return `${start}, ${e.startTime} to ${end}, ${e.endTime}`;
}

// The time column for an event on one of its days: "All day", "10:00 to 11:00",
// or how a longer event runs into or out of the day.
export function timeLabel(e: CalEvent, day: ISODate): string {
  if (e.allDay) return "All day";
  if (e.startDate < day) return e.endDate === day ? `Until ${e.endTime}` : "All day";
  return e.endDate === day ? `${e.startTime} to ${e.endTime}` : `From ${e.startTime}`;
}

// Where a new event starts: a date, and a time unless it lasts all day.
export interface EventSeed {
  date: ISODate;
  time?: HHMM | null;
  allDay?: boolean;
}

function dayNumber(iso: ISODate): number {
  const p = parseISO(iso);
  return p ? Date.UTC(p.year, p.month - 1, p.day) / 86_400_000 : NaN;
}

function absoluteMinutes(date: ISODate, time: HHMM): number {
  return dayNumber(date) * DAY_MINUTES + minutesOf(time);
}

function fromAbsoluteMinutes(total: number): { date: ISODate; time: HHMM } {
  const day = Math.floor(total / DAY_MINUTES);
  const d = new Date(day * 86_400_000);
  return { date: formatISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), time: hhmm(total - day * DAY_MINUTES) };
}

// A new event: an hour long from the time asked for, or from 09:00.
export function blankDraft(seed: EventSeed): EventDraft {
  const startTime = isHHMM(seed.time) ? seed.time : "09:00";
  const end = parseISO(seed.date) ? fromAbsoluteMinutes(absoluteMinutes(seed.date, startTime) + 60) : { date: seed.date, time: "10:00" };
  return {
    title: "",
    startDate: seed.date,
    endDate: end.date,
    startTime,
    endTime: end.time,
    allDay: Boolean(seed.allDay),
    category: "other",
    location: "",
    notes: "",
  };
}

// An existing event as the sheet edits it. An all day event keeps working
// times in reserve, so that turning All day off shows something sensible.
export function draftFromRow(row: CalendarEventRow): EventDraft {
  const timed = !row.all_day && isHHMM(row.start_time) && isHHMM(row.end_time);
  return {
    title: row.title ?? "",
    startDate: row.start_date,
    endDate: row.end_date,
    startTime: timed ? row.start_time : "09:00",
    endTime: timed ? row.end_time : "10:00",
    allDay: !timed,
    category: categoryOf(row.category),
    location: row.location ?? "",
    notes: row.notes ?? "",
  };
}

// Moves the start and carries the end with it, so that the length of the
// event is kept, as Google Calendar does. A start or end that cannot be read
// is moved on its own.
export function moveStart(d: EventDraft, patch: { startDate?: ISODate; startTime?: HHMM | null }): EventDraft {
  const startDate = patch.startDate ?? d.startDate;
  const startTime = patch.startTime !== undefined ? patch.startTime : d.startTime;
  const next: EventDraft = { ...d, startDate, startTime };
  if (!parseISO(d.startDate) || !parseISO(d.endDate) || !parseISO(startDate)) return next;
  if (d.allDay) {
    return { ...next, endDate: addDays(startDate, Math.max(dayNumber(d.endDate) - dayNumber(d.startDate), 0)) };
  }
  if (!isHHMM(d.startTime) || !isHHMM(d.endTime) || !isHHMM(startTime)) return next;
  const before = absoluteMinutes(d.startDate, d.startTime);
  const after = absoluteMinutes(d.endDate, d.endTime);
  const end = fromAbsoluteMinutes(absoluteMinutes(startDate, startTime) + (after > before ? after - before : 60));
  return { ...next, endDate: end.date, endTime: end.time };
}

// Only the columns an edit changed, as the outbox sends them: the draft the
// sheet started with is the thing to compare against, so a row that was never
// touched is never rewritten.
export function changedColumns(row: CalendarEventRow, draft: EventDraft): Partial<ReturnType<typeof draftColumns>> {
  const before = draftColumns(draftFromRow(row));
  const after = draftColumns(draft);
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof typeof after)[]) {
    if (after[key] !== before[key]) changed[key] = after[key];
  }
  return changed as Partial<typeof after>;
}
