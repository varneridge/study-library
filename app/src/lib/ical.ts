// Reads the subset of RFC 5545 that Google Calendar writes into its secret
// iCal feed, and turns it into one row per occurrence in this device's wall
// clock. Time zones come from the browser's own Intl database rather than a
// library, and recurrence covers the rules Google writes for ordinary events.
// A rule beyond that subset shows its first occurrence and is counted as
// skipped, which is visibly incomplete rather than silently wrong.

import { type ISODate, addDays, daysInMonth, formatISO, parseISO, weekdayMon0 } from "./civilDate";
import type { GcalEvent } from "./db";

export interface IcalWindow { from: ISODate; to: ISODate }
export interface IcalResult { events: GcalEvent[]; skipped: number; truncated: boolean }

export const MAX_EVENTS = 5000;
// A rule is never stepped more often than this, whatever it says.
const MAX_STEPS = 100_000;
const DAY_MS = 86_400_000;

// Joins folded lines: a line beginning with a space or a tab continues the
// one before it, less that first character. Blank lines are dropped.
export function unfold(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else if (line !== "") out.push(line);
  }
  return out;
}

export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const validZones = new Map<string, boolean>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, f);
  }
  return f;
}

function isZone(zone: string): boolean {
  let ok = validZones.get(zone);
  if (ok === undefined) {
    try {
      formatterFor(zone);
      ok = true;
    } catch {
      ok = false;
    }
    validZones.set(zone, ok);
  }
  return ok;
}

// How far the zone's wall clock is ahead of UTC at an instant, in minutes.
export function zoneOffsetMinutes(utcMs: number, zone: string): number {
  if (zone === "UTC") return 0;
  const parts: Record<string, string> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(utcMs))) parts[part.type] = part.value;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

// The instant at which the zone's wall clock reads the given time. The
// second pass settles times next to a change of the clocks; a time that the
// change skips lands just after it.
export function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  if (zone === "UTC") return guess;
  const first = guess - zoneOffsetMinutes(guess, zone) * 60_000;
  return guess - zoneOffsetMinutes(first, zone) * 60_000;
}

export function utcToWall(utcMs: number, zone: string): { date: ISODate; time: string } {
  const wall = new Date(utcMs + zoneOffsetMinutes(utcMs, zone) * 60_000);
  return {
    date: formatISO(wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate()),
    time: `${String(wall.getUTCHours()).padStart(2, "0")}:${String(wall.getUTCMinutes()).padStart(2, "0")}`,
  };
}

interface Prop { name: string; params: Record<string, string>; value: string }

// Splits "NAME;PARAM=a;PARAM2="b:c":value" on the first colon outside quotes.
function parseLine(line: string): Prop | null {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const parts: string[] = [];
  let current = "";
  inQuote = false;
  for (const ch of line.slice(0, colon)) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === ";" && !inQuote) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    let v = part.slice(eq + 1);
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[part.slice(0, eq).toUpperCase()] = v;
  }
  return { name: parts[0].toUpperCase(), params, value: line.slice(colon + 1) };
}

// A DTSTART-like value. zone is "UTC" for a trailing Z, the TZID when the
// browser knows it, and null for floating time, which is read as this
// device's wall clock unchanged.
type Stamp =
  | { allDay: true; date: ISODate }
  | { allDay: false; date: ISODate; h: number; mi: number; s: number; zone: string | null };

const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

function parseStamp(value: string, params: Record<string, string>): Stamp | null {
  const raw = value.trim();
  const d = DATE_RE.exec(raw);
  if (d) {
    const date = `${d[1]}-${d[2]}-${d[3]}`;
    return parseISO(date) ? { allDay: true, date } : null;
  }
  const t = DATE_TIME_RE.exec(raw);
  if (!t || params.VALUE === "DATE") return null;
  const date = `${t[1]}-${t[2]}-${t[3]}`;
  const h = Number(t[4]);
  const mi = Number(t[5]);
  const s = Math.min(Number(t[6]), 59);
  if (!parseISO(date) || h > 23 || mi > 59) return null;
  const tzid = params.TZID;
  const zone = t[7] ? "UTC" : tzid && isZone(tzid) ? tzid : null;
  return { allDay: false, date, h, mi, s, zone };
}

// The instant a stamp names, in milliseconds. Floating times and dates use
// their wall clock read as UTC, so they compare with others of their kind.
function instantOf(date: ISODate, h: number, mi: number, s: number, zone: string | null): number {
  const p = parseISO(date)!;
  if (zone === null) return Date.UTC(p.year, p.month - 1, p.day, h, mi, s);
  return wallToUtc(p.year, p.month, p.day, h, mi, zone) + s * 1000;
}

function stampMs(stamp: Stamp): number {
  return stamp.allDay ? instantOf(stamp.date, 0, 0, 0, null) : instantOf(stamp.date, stamp.h, stamp.mi, stamp.s, stamp.zone);
}

function dayNumber(iso: ISODate): number {
  const p = parseISO(iso)!;
  return Date.UTC(p.year, p.month - 1, p.day) / DAY_MS;
}

const DURATION_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

function parseDuration(value: string): { days: number; ms: number } | null {
  const m = DURATION_RE.exec(value.trim());
  if (!m || value.trim() === "P" || value.trim() === "PT") return null;
  if (m[1] === "-") return { days: 0, ms: 0 };
  const days = Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0);
  const ms = days * DAY_MS + (Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) * 1000;
  return { days, ms };
}

type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

interface Rule {
  freq: Freq;
  interval: number;
  count: number | null;
  until: Stamp | null;
  // Weekdays, Monday = 0, as civilDate counts them.
  byDay: number[] | null;
  byMonthDay: number[] | null;
  weekStart: number;
}

const WEEKDAYS: Record<string, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

// Reads an RRULE, or gives null for one outside the supported subset.
function parseRule(value: string, start: Stamp): Rule | null {
  const parts: Record<string, string> = {};
  for (const piece of value.split(";")) {
    const eq = piece.indexOf("=");
    if (eq > 0) parts[piece.slice(0, eq).toUpperCase()] = piece.slice(eq + 1).toUpperCase();
  }
  const freq = parts.FREQ;
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const startMonth = parseISO(start.date)!.month;
  for (const key of Object.keys(parts)) {
    if (["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "WKST"].includes(key)) continue;
    // A yearly rule naming its own start month says nothing more than FREQ.
    if (key === "BYMONTH" && freq === "YEARLY" && parts.BYMONTH === String(startMonth)) continue;
    return null;
  }
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1) return null;
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  if (count !== null && (!Number.isInteger(count) || count < 1)) return null;
  let until: Stamp | null = null;
  if (parts.UNTIL) {
    until = parseStamp(parts.UNTIL, {});
    if (!until) return null;
  }
  let byDay: number[] | null = null;
  if (parts.BYDAY) {
    if (freq !== "DAILY" && freq !== "WEEKLY") return null;
    byDay = [];
    for (const code of parts.BYDAY.split(",")) {
      if (!(code in WEEKDAYS)) return null;
      byDay.push(WEEKDAYS[code]);
    }
  }
  let byMonthDay: number[] | null = null;
  if (parts.BYMONTHDAY) {
    if (freq !== "MONTHLY") return null;
    byMonthDay = [];
    for (const n of parts.BYMONTHDAY.split(",")) {
      const day = Number(n);
      if (!Number.isInteger(day) || day < 1 || day > 31) return null;
      byMonthDay.push(day);
    }
    byMonthDay.sort((a, b) => a - b);
  }
  const weekStart = parts.WKST && parts.WKST in WEEKDAYS ? WEEKDAYS[parts.WKST] : 0;
  return { freq, interval, count, until, byDay, byMonthDay, weekStart };
}

// The start dates a rule gives, in order, in the event's own calendar,
// beginning with DTSTART itself. Stops past the last date or the year 2199.
function* ruleDates(rule: Rule, start: ISODate, last: ISODate): Generator<ISODate> {
  const p = parseISO(start)!;
  let steps = 0;
  const within = (iso: ISODate) => iso >= start && iso <= last;
  yield start;
  if (rule.freq === "DAILY") {
    for (let k = 1; steps++ < MAX_STEPS; k++) {
      const iso = addDays(start, k * rule.interval);
      if (iso > last || !parseISO(iso)) return;
      if (rule.byDay && !rule.byDay.includes(weekdayMon0(iso))) continue;
      yield iso;
    }
  } else if (rule.freq === "WEEKLY") {
    const days = (rule.byDay ?? [weekdayMon0(start)])
      .map((wd) => (wd - rule.weekStart + 7) % 7)
      .sort((a, b) => a - b);
    const firstWeek = addDays(start, -((weekdayMon0(start) - rule.weekStart + 7) % 7));
    for (let k = 0; steps++ < MAX_STEPS; k++) {
      const weekBegins = addDays(firstWeek, k * 7 * rule.interval);
      if (weekBegins > last) return;
      for (const offset of days) {
        const iso = addDays(weekBegins, offset);
        if (iso > start && within(iso)) yield iso;
      }
    }
  } else if (rule.freq === "MONTHLY") {
    const days = rule.byMonthDay ?? [p.day];
    for (let k = 0; steps++ < MAX_STEPS; k++) {
      const total = p.year * 12 + (p.month - 1) + k * rule.interval;
      const year = Math.floor(total / 12);
      const month = (total % 12) + 1;
      if (year > 2199 || formatISO(year, month, 1) > last) return;
      for (const day of days) {
        // A month without the day is skipped, as RFC 5545 requires.
        if (day > daysInMonth(year, month)) continue;
        const iso = formatISO(year, month, day);
        if (iso > start && within(iso)) yield iso;
      }
    }
  } else {
    for (let k = 1; steps++ < MAX_STEPS; k++) {
      const year = p.year + k * rule.interval;
      if (year > 2199 || formatISO(year, 1, 1) > last) return;
      // 29 February appears only in leap years.
      if (p.day > daysInMonth(year, p.month)) continue;
      const iso = formatISO(year, p.month, p.day);
      if (iso <= last) yield iso;
    }
  }
}

interface RawEvent {
  uid: string;
  summary: string;
  location: string;
  description: string;
  start: Stamp | null;
  end: Stamp | null;
  duration: string | null;
  rrule: string | null;
  exdates: Stamp[];
  recurrenceId: Stamp | null;
  cancelled: boolean;
}

function readEvents(text: string): RawEvent[] {
  const events: RawEvent[] = [];
  let current: RawEvent | null = null;
  // Depth of components nested inside the event, such as an alarm.
  let nested = 0;
  for (const line of unfold(text)) {
    const prop = parseLine(line);
    if (!prop) continue;
    const value = prop.value.toUpperCase();
    if (prop.name === "BEGIN") {
      if (current) nested++;
      else if (value === "VEVENT") {
        current = {
          uid: "", summary: "", location: "", description: "", start: null, end: null,
          duration: null, rrule: null, exdates: [], recurrenceId: null, cancelled: false,
        };
      }
      continue;
    }
    if (prop.name === "END") {
      if (current && nested > 0) nested--;
      else if (current && value === "VEVENT") {
        events.push(current);
        current = null;
      }
      continue;
    }
    if (!current || nested > 0) continue;
    switch (prop.name) {
      case "UID": current.uid = prop.value.trim(); break;
      case "SUMMARY": current.summary = unescapeText(prop.value); break;
      case "LOCATION": current.location = unescapeText(prop.value); break;
      case "DESCRIPTION": current.description = unescapeText(prop.value); break;
      case "DTSTART": current.start = parseStamp(prop.value, prop.params); break;
      case "DTEND": current.end = parseStamp(prop.value, prop.params); break;
      case "DURATION": current.duration = prop.value; break;
      case "RRULE": current.rrule = prop.value; break;
      case "RECURRENCE-ID": current.recurrenceId = parseStamp(prop.value, prop.params); break;
      case "STATUS": current.cancelled = value.trim() === "CANCELLED"; break;
      case "EXDATE":
        for (const v of prop.value.split(",")) {
          const stamp = parseStamp(v, prop.params);
          if (stamp) current.exdates.push(stamp);
        }
        break;
    }
  }
  return events;
}

// The stable part of a key: the occurrence's original start.
function occurrenceId(stamp: Stamp): string {
  if (stamp.allDay) return stamp.date;
  const ms = stampMs(stamp);
  const iso = new Date(ms).toISOString();
  return stamp.zone === null ? iso.slice(0, 16) : iso;
}

// Parses a feed into the occurrences that touch the window, converted from
// their own zones into localZone. Bad events are counted in skipped rather
// than thrown; more than MAX_EVENTS occurrences sets truncated.
export function parseIcal(text: string, window: IcalWindow, localZone?: string): IcalResult {
  const zoneWanted = localZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = zoneWanted && isZone(zoneWanted) ? zoneWanted : "UTC";
  const out = new Map<string, GcalEvent>();
  let skipped = 0;
  let truncated = false;

  const raws = readEvents(text);
  // Occurrences replaced by an edited copy, by UID, as instants and as dates.
  const replaced = new Map<string, { ms: Set<number>; dates: Set<ISODate> }>();
  raws.forEach((raw, i) => {
    if (!raw.uid) raw.uid = `nouid-${i}`;
    if (!raw.recurrenceId) return;
    const entry = replaced.get(raw.uid) ?? { ms: new Set<number>(), dates: new Set<ISODate>() };
    entry.ms.add(stampMs(raw.recurrenceId));
    if (raw.recurrenceId.allDay) entry.dates.add(raw.recurrenceId.date);
    replaced.set(raw.uid, entry);
  });

  const emit = (raw: RawEvent, idStamp: Stamp, startDate: ISODate, start: Stamp, length: { days: number; ms: number }) => {
    if (out.size >= MAX_EVENTS) {
      truncated = true;
      return;
    }
    let row: Omit<GcalEvent, "key" | "title" | "location" | "notes">;
    if (start.allDay) {
      row = {
        start_date: startDate,
        end_date: addDays(startDate, Math.max(length.days, 1) - 1),
        start_time: null,
        end_time: null,
        all_day: true,
      };
    } else {
      const startMs = instantOf(startDate, start.h, start.mi, start.s, start.zone);
      const endMs = startMs + Math.max(length.ms, 0);
      const show = (ms: number) => (start.zone === null ? utcToWall(ms, "UTC") : utcToWall(ms, zone));
      const a = show(startMs);
      const b = show(endMs);
      row = { start_date: a.date, end_date: b.date, start_time: a.time, end_time: b.time, all_day: false };
    }
    if (row.start_date > window.to || row.end_date < window.from) return;
    const key = `${raw.uid}|${occurrenceId(idStamp)}`;
    out.set(key, {
      key,
      title: raw.summary.trim() || "Untitled event",
      ...row,
      location: raw.location.trim() || null,
      notes: raw.description.trim() || null,
    });
  };

  for (const raw of raws) {
    if (truncated) break;
    const start = raw.start;
    if (!start) {
      skipped++;
      continue;
    }
    if (raw.cancelled) continue;

    // How long each occurrence lasts: whole days for an all day event, an
    // exact span otherwise, so an hour stays an hour across a change of clocks.
    let length = { days: 1, ms: 0 };
    if (raw.end) {
      if (start.allDay) length = { days: dayNumber(raw.end.date) - dayNumber(start.date), ms: 0 };
      else {
        const endMs = raw.end.allDay ? instantOf(raw.end.date, 0, 0, 0, start.zone) : stampMs(raw.end);
        length = { days: 0, ms: endMs - stampMs(start) };
      }
    } else if (raw.duration) {
      const parsed = parseDuration(raw.duration);
      if (parsed) length = start.allDay ? { days: parsed.days, ms: 0 } : parsed;
    } else if (!start.allDay) length = { days: 0, ms: 0 };

    // An edited occurrence stands alone, keyed by the occurrence it replaces.
    if (raw.recurrenceId) {
      emit(raw, raw.recurrenceId, start.date, start, length);
      continue;
    }

    const rule = raw.rrule ? parseRule(raw.rrule, start) : null;
    if (!raw.rrule || !rule) {
      if (raw.rrule) skipped++;
      emit(raw, start, start.date, start, length);
      continue;
    }

    const excluded = { ms: new Set<number>(), dates: new Set<ISODate>() };
    for (const ex of raw.exdates) {
      if (ex.allDay) excluded.dates.add(ex.date);
      else excluded.ms.add(stampMs(ex));
    }
    const swapped = replaced.get(raw.uid);
    // Converting zones moves a date by at most a day, and an occurrence that
    // begins before the window can still run into it.
    const last = addDays(window.to, 1);
    const earliest = addDays(window.from, -(Math.ceil(length.ms / DAY_MS) + length.days + 1));
    const untilMs = rule.until && !rule.until.allDay ? stampMs(rule.until) : null;
    let counted = 0;

    for (const date of ruleDates(rule, start.date, last)) {
      const occurrence: Stamp = start.allDay ? { allDay: true, date } : { ...start, date };
      const ms = stampMs(occurrence);
      if (rule.until) {
        if (rule.until.allDay ? date > rule.until.date : ms > (untilMs as number)) break;
      }
      counted++;
      if (rule.count !== null && counted > rule.count) break;
      if (date < earliest) continue;
      if (excluded.ms.has(ms) || excluded.dates.has(date)) continue;
      if (swapped && (swapped.ms.has(ms) || swapped.dates.has(date))) continue;
      emit(raw, occurrence, date, occurrence, length);
      if (truncated) break;
    }
  }

  const events = [...out.values()].sort((a, b) =>
    a.start_date.localeCompare(b.start_date)
    || (a.start_time ?? "").localeCompare(b.start_time ?? "")
    || a.key.localeCompare(b.key));
  return { events, skipped, truncated };
}
