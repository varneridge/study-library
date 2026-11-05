// Civil date calculations in UTC to eliminate British Summer Time and timezone offset bugs.
// Months are 1-based throughout (1 = January, 12 = December).

export type ISODate = string; // YYYY-MM-DD

const MIN_YEAR = 1900;
const MAX_YEAR = 2199;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UK_RE = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{2}|\d{4})$/;

const LONG_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

export function parseISO(str: string): { year: number; month: number; day: number } | null {
  if (!str) return null;
  const m = ISO_RE.exec(str);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  if (month < 1 || month > 12) return null;
  const maxDay = daysInMonth(year, month);
  if (day < 1 || day > maxDay) return null;
  return { year, month, day };
}

export function formatISO(year: number, month: number, day: number): ISODate {
  const y = String(year).padStart(4, "0");
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Reads local wall clock once to determine today, formatted as YYYY-MM-DD.
// Never calls .toISOString().
export function todayLocal(): ISODate {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return formatISO(year, month, day);
}

export function addDays(iso: ISODate, days: number): ISODate {
  const p = parseISO(iso);
  if (!p) return iso;
  const ms = Date.UTC(p.year, p.month - 1, p.day) + days * 86_400_000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  return formatISO(y, d.getUTCMonth() + 1, d.getUTCDate());
}

export function addMonths(iso: ISODate, delta: number): ISODate {
  const p = parseISO(iso);
  if (!p) return iso;
  const totalMonths = p.year * 12 + (p.month - 1) + delta;
  let targetYear = Math.floor(totalMonths / 12);
  let targetMonth = (totalMonths % 12) + 1;
  if (targetMonth < 1) {
    targetMonth += 12;
    targetYear -= 1;
  }
  if (targetYear < MIN_YEAR) return formatISO(MIN_YEAR, 1, 1);
  if (targetYear > MAX_YEAR) return formatISO(MAX_YEAR, 12, 31);
  const maxDay = daysInMonth(targetYear, targetMonth);
  const targetDay = Math.min(p.day, maxDay);
  return formatISO(targetYear, targetMonth, targetDay);
}

// Monday = 0 ... Sunday = 6
export function weekdayMon0(iso: ISODate): number {
  const p = parseISO(iso);
  if (!p) return 0;
  const dayOfWeek = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return (dayOfWeek + 6) % 7;
}

// First Monday strictly after the given date (1 to 7 days ahead)
export function nextMonday(iso: ISODate): ISODate {
  const wd = weekdayMon0(iso);
  const daysUntil = (7 - wd) % 7 || 7;
  return addDays(iso, daysUntil);
}

export interface CalendarDay {
  iso: ISODate;
  day: number;
  inMonth: boolean;
}

// Returns a fixed 42-cell array (6 weeks of 7 days starting on Monday)
export function monthGrid(year: number, month: number): CalendarDay[] {
  const firstOfMonth = formatISO(year, month, 1);
  const startOffset = weekdayMon0(firstOfMonth);
  const startDate = addDays(firstOfMonth, -startOffset);
  const startP = parseISO(startDate);
  const startMs = startP
    ? Date.UTC(startP.year, startP.month - 1, startP.day)
    : Date.UTC(year, month - 1, 1 - startOffset);

  const days: CalendarDay[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(startMs + i * 86_400_000);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    days.push({
      iso: formatISO(y, m, day),
      day,
      inMonth: y === year && m === month,
    });
  }
  return days;
}

// Accepts DD/MM/YYYY, D/M/YYYY, D/M/YY, DD/MM/YY, or YYYY-MM-DD.
// Uses backreference \2 to require matching separators (. or / or -).
// Expands two-digit years: <= 50 -> 2000+yy, > 50 -> 1900+yy.
// Validates bounds (1900 to 2199) and rejects invalid days like 31/02.
export function parseUK(str: string): ISODate | null {
  const trimmed = str.trim();
  if (!trimmed) return null;
  const isoMatch = parseISO(trimmed);
  if (isoMatch) return formatISO(isoMatch.year, isoMatch.month, isoMatch.day);

  const m = UK_RE.exec(trimmed);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[3], 10);
  let y = parseInt(m[4], 10);
  if (m[4].length === 2) {
    y = y <= 50 ? 2000 + y : 1900 + y;
  }
  if (y < MIN_YEAR || y > MAX_YEAR) return null;
  if (mo < 1 || mo > 12) return null;
  const maxDay = daysInMonth(y, mo);
  if (d < 1 || d > maxDay) return null;
  return formatISO(y, mo, d);
}

// Assembles weekday, day, month and year with single spaces via formatToParts.
// Guarantees deterministic format across engines (e.g. "Monday 15 June 2026").
// What a date card says about the date already chosen, beneath its title.
export function chosenDateText(value: string | null | undefined): string {
  const long = value ? formatLong(value) : "";
  return long ? `Now: ${long}` : "No date chosen yet";
}

export function formatLong(iso: ISODate): string {
  const p = parseISO(iso);
  if (!p) return "";
  const parts = LONG_FORMATTER.formatToParts(new Date(Date.UTC(p.year, p.month - 1, p.day)));
  const get = (type: string) => parts.find((pt) => pt.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}`;
}
