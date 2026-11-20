// What each source of events is called, and how one event is read out to a
// screen reader. The names are the ones the list of calendars uses, and every
// chip and row carries its source's name as well as its colour.

import type { CalEvent, CalendarSource } from "../../lib/calendar";
import { formatLong } from "../../lib/civilDate";

export const SOURCE_LABELS: Record<CalendarSource, string> = {
  personal: "Personal",
  google: "Google Calendar",
  deadline: "Job deadlines",
  check: "Job checks",
  essay: "Essay deadlines",
  tasks: "To do",
};

// "Seminar, Monday 16 November 2026, 10:00 to 11:00, Personal"
export function eventLabel(e: CalEvent): string {
  const start = formatLong(e.startDate);
  const end = formatLong(e.endDate);
  let when: string;
  if (e.allDay) when = e.startDate === e.endDate ? `${start}, all day` : `${start} to ${end}, all day`;
  else if (e.startDate === e.endDate) when = `${start}, ${e.startTime} to ${e.endTime}`;
  else when = `${start}, ${e.startTime} to ${end}, ${e.endTime}`;
  return `${e.title}, ${when}, ${SOURCE_LABELS[e.source]}`;
}
