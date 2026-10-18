// One way of writing dates across the app: "12 Oct", or "12 Oct 2026" when
// the year matters. Browsers write September as "Sept" in British English
// and every other month in three letters, so the app keeps its own names.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// utc reads the date's calendar day in UTC, for dates stored as UTC
// midnights; otherwise the local day is used.
export function shortDate(date: Date, { year = false, utc = false }: { year?: boolean; utc?: boolean } = {}): string {
  const day = utc ? date.getUTCDate() : date.getDate();
  const month = MONTHS[utc ? date.getUTCMonth() : date.getMonth()];
  const y = utc ? date.getUTCFullYear() : date.getFullYear();
  return year ? `${day} ${month} ${y}` : `${day} ${month}`;
}

// A span such as "12 to 16 Oct", or "28 Sep to 2 Oct" across a month.
export function spanText(start: Date, end: Date, utc = false): string {
  const sameMonth = (utc ? start.getUTCMonth() : start.getMonth()) === (utc ? end.getUTCMonth() : end.getMonth());
  const first = sameMonth ? String(utc ? start.getUTCDate() : start.getDate()) : shortDate(start, { utc });
  return `${first} to ${shortDate(end, { utc })}`;
}
