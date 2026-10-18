// Which teaching week it is today. LSE numbers eleven weeks in each of
// Autumn Term and Winter Term, each starting on a Monday. The 2026/27
// dates come from LSE's published teaching weeks. Later years follow the
// usual pattern, and any year can be corrected in Settings.

import { useSetting } from "./settings";
import { spanText } from "./dates";

export interface TermDates { AT: string; WT: string }
export interface TeachingWeek { term: "AT" | "WT"; number: number; upcoming: boolean }

const KNOWN: Record<number, TermDates> = {
  2026: { AT: "2026-09-28", WT: "2027-01-11" },
};

const DAY = 86_400_000;

function monday(date: Date): Date {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const shift = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - shift * DAY);
}

// The academic year a date falls in, by the year it began.
function yearOf(date: Date): number {
  return date.getMonth() >= 7 ? date.getFullYear() : date.getFullYear() - 1;
}

// Autumn Term starts on the first Monday on or after 25 September; Winter
// Term fifteen weeks later. This matches recent LSE years.
export function defaultDates(year: number): TermDates {
  if (KNOWN[year]) return KNOWN[year];
  const start = new Date(Date.UTC(year, 8, 25));
  const at = new Date(start.getTime() + ((8 - start.getUTCDay()) % 7) * DAY);
  const wt = new Date(at.getTime() + 15 * 7 * DAY);
  return { AT: at.toISOString().slice(0, 10), WT: wt.toISOString().slice(0, 10) };
}

export function teachingWeek(today: Date, dates: TermDates): TeachingWeek | null {
  const now = monday(today).getTime();
  for (const term of ["AT", "WT"] as const) {
    const start = new Date(`${dates[term]}T00:00:00Z`).getTime();
    const week = Math.floor((now - start) / (7 * DAY)) + 1;
    if (week >= 1 && week <= 11) return { term, number: week, upcoming: false };
    // In the weeks before a term starts, its first week is next.
    if (week < 1 && week >= -5) return { term, number: 1, upcoming: true };
  }
  return null;
}

export function useTermDates(): TermDates {
  const saved = useSetting<Partial<Record<number, TermDates>>>("term-dates", {});
  const year = yearOf(new Date());
  return saved[year] ?? defaultDates(year);
}

export function useTeachingWeek(): TeachingWeek | null {
  const dates = useTermDates();
  return teachingWeek(new Date(), dates);
}

export function currentYear(): number {
  return yearOf(new Date());
}

// The Monday to Friday a teaching week covers, as "28 Sep to 2 Oct".
export function weekDates(term: string, number: number, dates: TermDates): { start: Date; end: Date } | null {
  if (term !== "AT" && term !== "WT") return null;
  const start = new Date(new Date(`${dates[term]}T00:00:00Z`).getTime() + (number - 1) * 7 * DAY);
  return { start, end: new Date(start.getTime() + 4 * DAY) };
}

export function weekDatesText(term: string, number: number, dates: TermDates): string {
  const span = weekDates(term, number, dates);
  return span ? spanText(span.start, span.end, true) : "";
}

// True for the week that is running now, not for one that is only next.
export function isThisWeek(week: { term: string; number: number }, now: TeachingWeek | null): boolean {
  return Boolean(now && !now.upcoming && now.term === week.term && now.number === week.number);
}
