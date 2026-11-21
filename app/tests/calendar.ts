// Unit tests for the calendar's data layer, engine and iCal parser. Runs on
// its own with `npx tsx tests/calendar.ts` from app/, needing nothing but
// Node, and exits non-zero on the first failure. Time zone cases pass the
// zone explicitly, so they give the same answer on any machine.

import assert from "node:assert/strict";
import {
  type CalEvent,
  buildApplicationEvent,
  buildAssessmentDeadlineEvent,
  buildGcalEvent,
  buildModuleKeyEvent,
  buildPersonalEvent,
  buildProspectEvent,
  draftColumns,
  eventsOnDay,
  layoutDay,
  rangeFor,
  readCalendarSettings,
  stepAnchor,
  titleFor,
  validateDraft,
} from "../src/lib/calendar";
import { MAX_EVENTS, parseIcal, unescapeText, unfold, utcToWall, wallToUtc, zoneOffsetMinutes } from "../src/lib/ical";
import type { ApplicationRow, CalendarEventRow, ModuleRow, ProspectRow } from "../src/lib/types";
import { decode, encode } from "../worker/schema";

export function registerCalendarTests(test: (name: string, fn: () => void) => void): void {

const LONDON = "Europe/London";
const YEAR = { from: "2026-01-01", to: "2027-12-31" };

function ics(...events: string[][]): string {
  const body = events.map((lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n")).join("\r\n");
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Google Inc//Google Calendar 70.9054//EN\r\n${body}\r\nEND:VCALENDAR\r\n`;
}

function timed(key: string, startTime: string, endTime: string, day = "2026-11-16"): CalEvent {
  return { key, source: "personal", title: key, startDate: day, endDate: day, startTime, endTime, allDay: false, editable: true };
}

// Phase 1: the Worker schema.

test("all_day defaults to 0 when a new row leaves it out", () => {
  assert.equal(encode("calendar_events", "all_day", undefined), 0);
  assert.equal(encode("calendar_events", "all_day", true), 1);
});

test("category defaults to other", () => {
  assert.equal(encode("calendar_events", "category", undefined), "other");
});

test("a module's missing title stays null, so title never joined DEFAULTS", () => {
  assert.equal(encode("modules", "title", undefined), null);
  assert.equal(encode("calendar_events", "title", undefined), null);
});

test("decode turns all_day back into a boolean", () => {
  assert.equal(decode("calendar_events", { all_day: 1, deleted: 0 }).all_day, true);
  assert.equal(decode("calendar_events", { all_day: 0, deleted: 0 }).all_day, false);
});

// Phase 2: the engine.

test("rangeFor covers the whole month grid, a week, a day and 60 agenda days", () => {
  assert.deepEqual(rangeFor("month", "2026-11-15"), { from: "2026-10-26", to: "2026-12-06" });
  assert.deepEqual(rangeFor("week", "2026-11-15"), { from: "2026-11-09", to: "2026-11-15" });
  assert.deepEqual(rangeFor("day", "2026-11-15"), { from: "2026-11-15", to: "2026-11-15" });
  assert.deepEqual(rangeFor("agenda", "2026-11-15"), { from: "2026-11-15", to: "2027-01-13" });
});

test("stepAnchor keeps the day where the month allows", () => {
  assert.equal(stepAnchor("month", "2026-01-31", 1), "2026-02-28");
  assert.equal(stepAnchor("week", "2026-11-15", -1), "2026-11-08");
  assert.equal(stepAnchor("day", "2026-12-31", 1), "2027-01-01");
  assert.equal(stepAnchor("agenda", "2026-11-15", 1), "2027-01-14");
});

test("titleFor names months, weeks across a month or a year, days and the agenda", () => {
  assert.equal(titleFor("month", "2026-11-15"), "November 2026");
  assert.equal(titleFor("week", "2026-11-18"), "16 to 22 November 2026");
  assert.equal(titleFor("week", "2026-11-30"), "30 November to 6 December 2026");
  assert.equal(titleFor("week", "2026-12-30"), "28 December 2026 to 3 January 2027");
  assert.equal(titleFor("day", "2026-11-16"), "Monday 16 November 2026");
  assert.equal(titleFor("agenda", "2026-11-16"), "From Monday 16 November 2026");
});

test("layoutDay shares columns between overlapping events and frees them after", () => {
  const placed = layoutDay([timed("a", "09:00", "10:00"), timed("b", "09:30", "10:30"), timed("c", "11:00", "12:00")], "2026-11-16");
  const by = Object.fromEntries(placed.map((p) => [p.event.key, p]));
  assert.deepEqual([by.a.col, by.a.cols, by.b.col, by.b.cols], [0, 2, 1, 2]);
  assert.deepEqual([by.c.col, by.c.cols], [0, 1]);
  assert.deepEqual([by.a.top, by.a.height], [540, 60]);
});

test("layoutDay reuses a freed column within a cluster", () => {
  const placed = layoutDay([timed("a", "09:00", "12:00"), timed("b", "09:00", "10:00"), timed("c", "10:00", "11:00")], "2026-11-16");
  const by = Object.fromEntries(placed.map((p) => [p.event.key, p]));
  assert.deepEqual([by.a.col, by.b.col, by.c.col, by.c.cols], [0, 1, 1, 2]);
});

test("a ten minute event is drawn fifteen minutes tall", () => {
  const event = buildPersonalEvent(row({ start_time: "09:00", end_time: "09:10" }))!;
  assert.equal(event.endTime, "09:15");
  assert.equal(layoutDay([timed("a", "09:00", "09:10")], "2026-11-16")[0].height, 15);
});

test("an event over midnight is clipped to each day", () => {
  const e: CalEvent = { ...timed("n", "22:00", "02:00"), endDate: "2026-11-17" };
  assert.deepEqual([layoutDay([e], "2026-11-16")[0].top, layoutDay([e], "2026-11-16")[0].height], [1320, 120]);
  assert.deepEqual([layoutDay([e], "2026-11-17")[0].top, layoutDay([e], "2026-11-17")[0].height], [0, 120]);
});

test("eventsOnDay lists all day events first, then by time", () => {
  const allDay: CalEvent = { ...timed("z", "00:00", "00:00"), allDay: true, startTime: null, endTime: null };
  const keys = eventsOnDay([timed("late", "15:00", "16:00"), allDay, timed("early", "08:00", "09:00")], "2026-11-16").map((e) => e.key);
  assert.deepEqual(keys, ["z", "early", "late"]);
});

function row(over: Partial<CalendarEventRow> = {}): CalendarEventRow {
  return {
    id: "r1", modified_at: "2026-11-15T10:00:00Z", deleted: false, title: "Seminar prep",
    start_date: "2026-11-16", end_date: "2026-11-16", start_time: "10:00", end_time: "11:00",
    all_day: false, category: "lecture", location: null, notes: null, ...over,
  };
}

test("buildPersonalEvent keeps the invariants and skips deleted rows", () => {
  const e = buildPersonalEvent(row())!;
  assert.equal(e.key, "p:r1");
  assert.equal(e.editable, true);
  assert.equal(buildPersonalEvent(row({ deleted: true })), null);
  assert.equal(buildPersonalEvent(row({ start_date: "2026-02-30" })), null);
  const allDay = buildPersonalEvent(row({ all_day: true }))!;
  assert.deepEqual([allDay.startTime, allDay.endTime], [null, null]);
  assert.equal(buildPersonalEvent(row({ category: "party" as never }))!.category, "other");
  assert.equal(buildPersonalEvent(row({ end_date: "2026-11-01" }))!.endDate, "2026-11-16");
});

test("an event ending at midnight ends at 23:59 the day before", () => {
  const e = buildPersonalEvent(row({ start_time: "23:00", end_date: "2026-11-17", end_time: "00:00" }))!;
  assert.deepEqual([e.endDate, e.endTime], ["2026-11-16", "23:59"]);
});

test("a deadline, a check and a key date link to their pages", () => {
  const app = { id: "a1", deleted: false, employer: "Arup", role: "Graduate planner", next_deadline: "2026-11-20" } as ApplicationRow;
  const d = buildApplicationEvent(app)!;
  assert.deepEqual([d.key, d.title, d.startDate, d.allDay], ["d:a1", "Deadline: Arup, Graduate planner", "2026-11-20", true]);
  assert.deepEqual(d.to, { view: "jobs", app: "a1" });
  assert.equal(buildApplicationEvent({ ...app, next_deadline: null }), null);
  assert.equal(buildApplicationEvent({ ...app, next_deadline: "soon" }), null);

  const prospect = { id: "p1", deleted: false, employer: "Civil Service", programme: "Fast Stream", next_check: "2026-12-01" } as ProspectRow;
  const c = buildProspectEvent(prospect)!;
  assert.deepEqual([c.key, c.title], ["c:p1", "Check: Civil Service, Fast Stream"]);
  assert.deepEqual(c.to, { view: "jobs", prospect: "p1" });

  const module = { id: "m1", deleted: false, code: "HY310" } as ModuleRow;
  const k = buildModuleKeyEvent(module, { id: "k1", label: "Essay due", date: "2027-01-12" })!;
  assert.deepEqual([k.key, k.title, k.startDate], ["e:m1:k1", "HY310: Essay due", "2027-01-12"]);
  assert.deepEqual(k.to, { view: "assessment", id: "m1" });
});

test("an essay's due date lasts the day and links to its own essay", () => {
  const module = { id: "m1", deleted: false, code: "HY310" } as ModuleRow;
  const first = buildAssessmentDeadlineEvent(module, "assessment:m1", { title: "  ", dueDate: "2027-01-12" })!;
  assert.deepEqual(
    [first.key, first.source, first.title, first.startDate, first.endDate, first.allDay, first.editable],
    ["a:assessment:m1", "essay", "HY310: Essay due", "2027-01-12", "2027-01-12", true, false],
  );
  assert.deepEqual(first.to, { view: "assessment", id: "m1" });

  const second = buildAssessmentDeadlineEvent(module, "assessment:m1:e2", { title: "Reformation essay", dueDate: "2027-03-02T12:00:00.000Z" })!;
  assert.deepEqual([second.key, second.title, second.startDate], ["a:assessment:m1:e2", "HY310: Reformation essay", "2027-03-02"]);
  assert.deepEqual(second.to, { view: "assessment", id: "m1", essay: "e2" });

  // A title that already names the module is not prefixed twice, and the default essay links without an essay id.
  const named = buildAssessmentDeadlineEvent(module, "assessment:m1:default", { title: "HY310 Essay", dueDate: "2027-01-12" })!;
  assert.equal(named.title, "HY310 Essay");
  assert.deepEqual(named.to, { view: "assessment", id: "m1" });
  assert.equal(buildAssessmentDeadlineEvent(undefined, "assessment:m1", { dueDate: "2027-01-12" })!.title, "Essay due");

  assert.equal(buildAssessmentDeadlineEvent(module, "assessment:m1", { title: "No date", dueDate: null }), null);
  assert.equal(buildAssessmentDeadlineEvent(module, "assessment:m1", { dueDate: "soon" }), null);
  assert.equal(buildAssessmentDeadlineEvent(module, "assessment:m1", { enabled: false, dueDate: "2027-01-12" }), null);
  assert.equal(buildAssessmentDeadlineEvent({ ...module, deleted: true }, "assessment:m1", { dueDate: "2027-01-12" }), null);
  assert.equal(buildAssessmentDeadlineEvent(module, "assessment-notes:m1", { dueDate: "2027-01-12" }), null);
  assert.equal(buildAssessmentDeadlineEvent(module, "assessment:m1", null), null);
});

test("a Google row becomes a read only event", () => {
  const g = buildGcalEvent({
    key: "u1|2026-11-16", title: "", start_date: "2026-11-16", end_date: "2026-11-16",
    start_time: null, end_time: null, all_day: true, location: null, notes: null,
  })!;
  assert.deepEqual([g.key, g.title, g.editable, g.source], ["g:u1|2026-11-16", "Untitled event", false, "google"]);
});

test("validateDraft names the first problem", () => {
  const draft = {
    title: "Tutorial", startDate: "2026-11-16", endDate: "2026-11-16", startTime: "10:00", endTime: "11:00",
    allDay: false, category: "appointment" as const, location: " Room 2 ", notes: "",
  };
  assert.equal(validateDraft(draft), null);
  assert.equal(validateDraft({ ...draft, title: "   " }), "title");
  assert.equal(validateDraft({ ...draft, endTime: "09:00" }), "end_before_start");
  assert.equal(validateDraft({ ...draft, endTime: "10:00" }), "end_before_start");
  assert.equal(validateDraft({ ...draft, startTime: "25:00" }), "bad_time");
  assert.equal(validateDraft({ ...draft, endDate: "2026-02-30" }), "bad_date");
  assert.equal(validateDraft({ ...draft, allDay: true, startTime: null, endTime: null }), null);
  assert.equal(validateDraft({ ...draft, endDate: "2026-11-17", endTime: "09:00" }), null);
  const cols = draftColumns({ ...draft, allDay: true });
  assert.deepEqual([cols.start_time, cols.end_time, cols.location, cols.notes], [null, null, "Room 2", null]);
});

test("readCalendarSettings falls back to defaults for anything malformed", () => {
  assert.deepEqual(readCalendarSettings(undefined), { icsUrl: null, hidden: [] });
  assert.deepEqual(readCalendarSettings({ icsUrl: "  ", hidden: "google" }), { icsUrl: null, hidden: [] });
  assert.deepEqual(
    readCalendarSettings({ icsUrl: " https://calendar.google.com/x.ics ", hidden: ["essay", "nonsense", "google", "essay"] }),
    { icsUrl: "https://calendar.google.com/x.ics", hidden: ["google", "essay"] },
  );
});

// Phase 3: the iCal parser.

test("folded lines join and text unescapes", () => {
  assert.deepEqual(unfold("SUMMARY:Long\r\n  title\r\n\t goes on\r\nUID:1"), ["SUMMARY:Long title goes on", "UID:1"]);
  assert.equal(unescapeText("Room 2\\, Senate House\\nBring notes\\; and \\\\ pens"), "Room 2, Senate House\nBring notes; and \\ pens");
});

test("an all day event's DTEND is exclusive", () => {
  const { events } = parseIcal(ics(["UID:a", "DTSTART;VALUE=DATE:20261116", "DTEND;VALUE=DATE:20261117", "SUMMARY:Reading week"]), YEAR, LONDON);
  assert.deepEqual([events[0].start_date, events[0].end_date, events[0].all_day, events[0].start_time], ["2026-11-16", "2026-11-16", true, null]);
});

test("London wall time holds after the clocks go forward, and UTC converts", () => {
  const zoned = parseIcal(ics(["UID:z", "DTSTART;TZID=Europe/London:20260330T090000", "DTEND;TZID=Europe/London:20260330T100000", "SUMMARY:Lecture"]), YEAR, LONDON);
  assert.deepEqual([zoned.events[0].start_time, zoned.events[0].end_time], ["09:00", "10:00"]);
  const utc = parseIcal(ics(["UID:u", "DTSTART:20260715T090000Z", "DTEND:20260715T093000Z", "SUMMARY:Call"]), YEAR, LONDON);
  assert.deepEqual([utc.events[0].start_time, utc.events[0].end_time], ["10:00", "10:30"]);
  assert.equal(zoneOffsetMinutes(Date.UTC(2026, 0, 15), LONDON), 0);
  assert.equal(zoneOffsetMinutes(Date.UTC(2026, 6, 15), LONDON), 60);
  assert.equal(wallToUtc(2026, 7, 15, 10, 0, LONDON), Date.UTC(2026, 6, 15, 9, 0));
  assert.deepEqual(utcToWall(Date.UTC(2026, 9, 25, 0, 30), LONDON), { date: "2026-10-25", time: "01:30" });
});

test("a weekly lecture keeps its wall time across the clocks going back", () => {
  const { events } = parseIcal(ics([
    "UID:w", "DTSTART;TZID=Europe/London:20261019T100000", "DTEND;TZID=Europe/London:20261019T110000",
    "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:Lecture",
  ]), YEAR, LONDON);
  assert.deepEqual(events.map((e) => `${e.start_date} ${e.start_time}`), ["2026-10-19 10:00", "2026-10-26 10:00", "2026-11-02 10:00"]);
});

test("BYDAY with COUNT, EXDATE and a RECURRENCE-ID override", () => {
  const { events, skipped } = parseIcal(ics(
    [
      "UID:s", "DTSTART;TZID=Europe/London:20261116T140000", "DTEND;TZID=Europe/London:20261116T150000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4", "EXDATE;TZID=Europe/London:20261118T140000", "SUMMARY:Seminar",
    ],
    [
      "UID:s", "RECURRENCE-ID;TZID=Europe/London:20261123T140000",
      "DTSTART;TZID=Europe/London:20261123T160000", "DTEND;TZID=Europe/London:20261123T170000", "SUMMARY:Seminar (moved)",
    ],
  ), YEAR, LONDON);
  assert.equal(skipped, 0);
  assert.deepEqual(events.map((e) => `${e.start_date} ${e.start_time} ${e.title}`), [
    "2026-11-16 14:00 Seminar",
    "2026-11-23 16:00 Seminar (moved)",
    "2026-11-25 14:00 Seminar",
  ]);
  assert.equal(new Set(events.map((e) => e.key)).size, 3);
});

test("a cancelled event or occurrence is dropped", () => {
  const { events } = parseIcal(ics(
    ["UID:c", "DTSTART:20261116T100000Z", "DTEND:20261116T110000Z", "STATUS:CANCELLED", "SUMMARY:Gone"],
    ["UID:r", "DTSTART;VALUE=DATE:20261116", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Daily"],
    ["UID:r", "RECURRENCE-ID;VALUE=DATE:20261117", "DTSTART;VALUE=DATE:20261117", "STATUS:CANCELLED", "SUMMARY:Daily"],
  ), YEAR, LONDON);
  assert.deepEqual(events.map((e) => e.start_date), ["2026-11-16", "2026-11-18"]);
});

test("an unsupported rule shows its first occurrence and counts as skipped", () => {
  const { events, skipped } = parseIcal(ics(["UID:o", "DTSTART;VALUE=DATE:20261110", "RRULE:FREQ=MONTHLY;BYDAY=2TU", "SUMMARY:Board"]), YEAR, LONDON);
  assert.equal(events.length, 1);
  assert.equal(skipped, 1);
});

test("a monthly rule on the 31st skips shorter months", () => {
  const { events } = parseIcal(ics(["UID:m", "DTSTART;VALUE=DATE:20260131", "RRULE:FREQ=MONTHLY;COUNT=4", "SUMMARY:Rent"]), YEAR, LONDON);
  assert.deepEqual(events.map((e) => e.start_date), ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31"]);
});

test("UNTIL, INTERVAL, yearly 29 February and DURATION", () => {
  const until = parseIcal(ics(["UID:u", "DTSTART:20261102T090000Z", "DURATION:PT1H30M", "RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261201T000000Z", "SUMMARY:x"]), YEAR, "UTC");
  assert.deepEqual(until.events.map((e) => `${e.start_date} ${e.end_time}`), ["2026-11-02 10:30", "2026-11-16 10:30", "2026-11-30 10:30"]);
  const leap = parseIcal(ics(["UID:l", "DTSTART;VALUE=DATE:20240229", "RRULE:FREQ=YEARLY", "SUMMARY:Leap"]), { from: "2024-01-01", to: "2032-12-31" }, LONDON);
  assert.deepEqual(leap.events.map((e) => e.start_date), ["2024-02-29", "2028-02-29", "2032-02-29"]);
});

test("an unknown TZID reads as floating rather than throwing, and a missing DTSTART is skipped", () => {
  const { events, skipped } = parseIcal(ics(
    ["UID:t", "DTSTART;TZID=GMT Standard Time:20261116T090000", "DTEND;TZID=GMT Standard Time:20261116T100000", "SUMMARY:Odd"],
    ["UID:n", "SUMMARY:No start"],
  ), YEAR, LONDON);
  assert.deepEqual([events[0].start_time, events[0].end_time, skipped], ["09:00", "10:00", 1]);
});

test("only occurrences touching the window are kept, and alarms are ignored", () => {
  const { events } = parseIcal(ics([
    "UID:d", "DTSTART;VALUE=DATE:20200101", "RRULE:FREQ=DAILY", "SUMMARY:Journal",
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Should not replace", "END:VALARM",
  ]), { from: "2026-11-16", to: "2026-11-18" }, LONDON);
  assert.deepEqual(events.map((e) => e.start_date), ["2026-11-16", "2026-11-17", "2026-11-18"]);
  assert.equal(events[0].notes, null);
});

  test("more than MAX_EVENTS occurrences sets truncated", () => {
    const { events, truncated } = parseIcal(ics(["UID:x", "DTSTART:20260101T090000Z", "RRULE:FREQ=DAILY", "SUMMARY:x"]), { from: "2026-01-01", to: "2199-12-31" }, "UTC");
    assert.equal(truncated, true);
    assert.equal(events.length, MAX_EVENTS);
  });
}

let passed = 0;
registerCalendarTests((name, fn) => {
  try {
    fn();
    passed++;
  } catch (error) {
    console.error(`FAILED: ${name}`);
    throw error;
  }
});
console.log(`calendar: ${passed} tests passed`);
