/** Date and stage helpers for job application cards. All arithmetic uses local calendar days. */

const DAY_MS = 86_400_000;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type DateInput = string | number | Date | null | undefined;

/**
 * Parses a date, treating "YYYY-MM-DD" as a local date. The built-in parser
 * reads such strings as UTC midnight, which shows the previous day to anyone
 * west of Greenwich.
 */
export function parseLocalDate(input: DateInput): Date | null {
  if (input === null || input === undefined || input === '') return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;

  if (typeof input === 'string') {
    const match = DATE_ONLY_RE.exec(input.trim());
    if (match) {
      const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
      const date = new Date(year, month - 1, day);
      const valid =
        date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
      return valid ? date : null;
    }
  }

  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Counting via UTC day numbers built from local parts keeps DST changes from skewing results. */
const dayNumber = (date: Date): number =>
  Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);

export const calendarDaysBetween = (from: Date, to: Date): number => dayNumber(to) - dayNumber(from);

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;

const pad = (n: number): string => String(n).padStart(2, '0');

export const toIsoDate = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export function formatShortDate(date: Date, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(date);
}

export type DeadlineUrgency = 'overdue' | 'today' | 'soon' | 'upcoming' | 'later';

export type DeadlineDescription = {
  days: number;
  label: string;
  absolute: string;
  iso: string;
  urgency: DeadlineUrgency;
};

export function describeDeadline(input: DateInput, now: Date = new Date()): DeadlineDescription | null {
  const date = parseLocalDate(input);
  if (!date) return null;

  const days = calendarDaysBetween(now, date);
  let label: string;
  let urgency: DeadlineUrgency;

  if (days < 0) {
    label = `Overdue by ${plural(-days, 'day')}`;
    urgency = 'overdue';
  } else if (days === 0) {
    label = 'Due today';
    urgency = 'today';
  } else if (days === 1) {
    label = 'Due tomorrow';
    urgency = 'soon';
  } else {
    label = `Due in ${plural(days, 'day')}`;
    urgency = days <= 3 ? 'soon' : days <= 14 ? 'upcoming' : 'later';
  }

  return { days, label, absolute: formatShortDate(date, now), iso: toIsoDate(date), urgency };
}

/**
 * Chooses the deadline a card should show: the earliest that is today or
 * later, or failing that the most recent overdue one, so nothing missed is hidden.
 */
export function pickNextDeadline(inputs: readonly DateInput[], now: Date = new Date()): Date | null {
  const dates = inputs.map(parseLocalDate).filter((d): d is Date => d !== null);
  const upcoming = dates
    .filter((d) => calendarDaysBetween(now, d) >= 0)
    .sort((a, b) => a.getTime() - b.getTime());
  if (upcoming.length > 0) return upcoming[0];
  const past = dates.sort((a, b) => b.getTime() - a.getTime());
  return past[0] ?? null;
}

export function describeTimeInStage(since: DateInput, now: Date = new Date()): string | null {
  const date = parseLocalDate(since);
  if (!date) return null;
  const days = Math.max(0, calendarDaysBetween(date, now));
  if (days === 0) return 'In stage since today';
  if (days < 14) return `${plural(days, 'day')} in stage`;
  return `${plural(Math.floor(days / 7), 'week')} in stage`;
}

export function formatAppliedDate(applied: DateInput, now: Date = new Date()): string | null {
  const date = parseLocalDate(applied);
  return date ? `Applied ${formatShortDate(date, now)}` : null;
}

export type StageTone = 'prospect' | 'applied' | 'interview' | 'offer' | 'closed';

/** Order matters, because "Offer declined" must read as closed rather than as an offer. */
const STAGE_TONE_RULES: ReadonlyArray<readonly [RegExp, StageTone]> = [
  [/reject|declin|withdr|unsuccess|closed|ghost/i, 'closed'],
  [/offer|accept/i, 'offer'],
  [/interview|assess|test|screen/i, 'interview'],
  [/appl|submit/i, 'applied'],
];

export function stageTone(stage: string): StageTone {
  for (const [pattern, tone] of STAGE_TONE_RULES) {
    if (pattern.test(stage)) return tone;
  }
  return 'prospect';
}
