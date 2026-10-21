// Minimal test runner: npm test
process.env.TZ = "Europe/London";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keyBetween, keysAfter } from "../src/lib/keys";
import { slidesBase, isPlaceName, freeName, fileGivenTitle, safeFileName, extensionFor, readingFileName } from "../src/lib/names";
import { parseTitle } from "../src/lib/parse";
import { fullTitle, shortTitle, chicagoBibliography, chicagoNote, parsePeople } from "../src/lib/titles";
import { positionsFor, splitQuestions, type Saved } from "../src/lib/notes";
import { changedColumns } from "../src/lib/sync";
import { smoothRects } from "../src/components/reader/pages";
import {
  deadlineState, deadlineWords, evaluateStageChange, eventsToRestore, formatDate, formatDuration,
  daysSinceApplied, daysInStage, entryTimeText, getTimelineEntries,
  likelyNextStages, matches, normaliseUrl, parseEntryTime,
  sortApplications, sortEvents, STAGE_GRID, STAGES, stageOf, summarise,
  undoStageChangeChanges, stageShort, stepLength, inStageWords, currentStageSince, entryDate,
  appliedDateChanges, entryEditChanges, firstAppliedEntry,
} from "../src/lib/jobs";
import type { ApplicationEventRow, ApplicationRow } from "../src/lib/types";
import { paragraphs, tidy } from "../src/lib/transcriptImport";

let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n${(error as Error).message}`);
  }
}

const fixtures = JSON.parse(readFileSync(new URL("../../shared/title-fixtures.json", import.meta.url), "utf8"));
for (const fixture of fixtures) {
  test(`parse ${fixture.input.slice(0, 50)}`, () => {
    assert.deepEqual(parseTitle(fixture.input), fixture.expect);
  });
}

test("full and short titles skip missing parts", () => {
  const base = { kind: "secondary" as const, author: "Westad, O. A.", year: 2012, title: "Empire", source: "in Restless Empire", pages: null, doc_date: null };
  assert.equal(fullTitle(base), "Westad, O. A. (2012) \u2018Empire\u2019, in Restless Empire");
  assert.equal(shortTitle(base), "Westad (2012) \u2018Empire\u2019");
  assert.equal(fullTitle({ ...base, author: null, year: null, source: null }), "\u2018Empire\u2019");
});

test("an apostrophe inside a title curls to match its quotation marks", () => {
  const item = { kind: "secondary" as const, author: "Woolf, S.", year: 1991, title: "Napoleon's Integration of Europe", source: null, pages: null, doc_date: null };
  assert.equal(shortTitle(item), "Woolf (1991) \u2018Napoleon\u2019s Integration of Europe\u2019");
});

test("primary titles", () => {
  const primary = { kind: "primary" as const, author: "Mao Zedong", year: null, title: "On the Question of the Differentiation of the Three Worlds", source: null, pages: null, doc_date: "22 Feb 1974" };
  assert.equal(fullTitle(primary), "Mao Zedong, \u2018On the Question of the Differentiation of the Three Worlds\u2019, 22 Feb 1974");
  assert.equal(fullTitle({ ...primary, author: null, title: "Memorandum of Conversation between Mikoyan and Mao", doc_date: "30 Jan 1949" }),
    "Memorandum of Conversation between Mikoyan and Mao, 30 Jan 1949");
});

test("Chicago 18th edition citations for articles, chapters, books and primary sources", () => {
  const article = {
    kind: "secondary" as const,
    work_kind: "article" as const,
    author: "Mombauer, Annika",
    year: 2016,
    title: "Sir Edward Grey, Germany, and the Outbreak of the First World War: A Re-Evaluation",
    source: "The International History Review",
    volume: "38",
    issue: "2",
    pages: "301-25",
    doi: "https://doi.org/10.1080/07075332.2015.1134622",
  };
  assert.equal(
    chicagoBibliography(article),
    "Mombauer, Annika. \u201cSir Edward Grey, Germany, and the Outbreak of the First World War: A Re-Evaluation.\u201d The International History Review 38, no. 2 (2016): 301-25. https://doi.org/10.1080/07075332.2015.1134622.",
  );
  assert.equal(
    chicagoNote(article, "305"),
    "Annika Mombauer, \u201cSir Edward Grey, Germany, and the Outbreak of the First World War: A Re-Evaluation,\u201d The International History Review 38, no. 2 (2016): 305, https://doi.org/10.1080/07075332.2015.1134622.",
  );

  const chapter = {
    kind: "secondary" as const,
    work_kind: "chapter" as const,
    author: "Beloff, Max",
    editor: "Blake, Robert and Louis, Wm. Roger",
    year: 1993,
    title: "Churchill and Europe",
    source: "Churchill",
    publisher: "Oxford University Press",
    pages: "443-56",
    doi: "10.1093/acprof:oso/9780198206262.001.0001",
  };
  assert.equal(
    chicagoBibliography(chapter),
    "Beloff, Max. \u201cChurchill and Europe.\u201d In Churchill, edited by Robert Blake and Wm. Roger Louis, 443-56. Oxford University Press, 1993. https://doi.org/10.1093/acprof:oso/9780198206262.001.0001.",
  );
  assert.equal(
    chicagoNote(chapter, "448"),
    "Max Beloff, \u201cChurchill and Europe,\u201d in Churchill, ed. Robert Blake and Wm. Roger Louis (Oxford University Press, 1993), 448, https://doi.org/10.1093/acprof:oso/9780198206262.001.0001.",
  );

  const book = {
    kind: "secondary" as const,
    work_kind: "book" as const,
    author: "Lüthi, Lorenz M.",
    year: 2008,
    title: "The Sino-Soviet Split: Cold War in the Communist World",
    source: null,
    publisher: "Princeton University Press",
  };
  assert.equal(
    chicagoBibliography(book),
    "Lüthi, Lorenz M. The Sino-Soviet Split: Cold War in the Communist World. Princeton University Press, 2008.",
  );
  assert.equal(
    chicagoNote(book, "246"),
    "Lorenz M. Lüthi, The Sino-Soviet Split: Cold War in the Communist World (Princeton University Press, 2008), 246.",
  );

  const primary = {
    kind: "primary" as const,
    work_kind: "primary" as const,
    author: "Mao Zedong",
    title: "On the Question of the Differentiation of the Three Worlds",
    source: "History and Public Policy Program Digital Archive, Woodrow Wilson International Center for Scholars",
    doc_date: "22 Feb 1974",
  };
  assert.equal(
    chicagoBibliography(primary),
    "Mao Zedong. \u201cOn the Question of the Differentiation of the Three Worlds.\u201d 22 Feb 1974. History and Public Policy Program Digital Archive, Woodrow Wilson International Center for Scholars.",
  );
  assert.equal(
    chicagoNote(primary),
    "Mao Zedong, \u201cOn the Question of the Differentiation of the Three Worlds,\u201d 22 Feb 1974, History and Public Policy Program Digital Archive, Woodrow Wilson International Center for Scholars.",
  );
});

test("keys from the Python importer work with the JS library", () => {
  // These come from backend/study/keys.py: a0, a1 ... az, b00.
  const python = ["a0", "a1", "a9", "aA", "az", "b00", "b01"];
  for (let i = 0; i < python.length - 1; i += 1) {
    const between = keyBetween(python[i], python[i + 1]);
    assert.ok(python[i] < between && between < python[i + 1]);
  }
  assert.equal(keysAfter(null, 2)[0], "a0");
  assert.equal(keyBetween("az", null), "b00");
});

test("pasted seminar questions lose their numbering", () => {
  assert.deepEqual(
    splitQuestions("1. How far did the Cold War matter?\n2) Was it new?\n\nQ3: Why 1949?\n- A bullet point question"),
    ["How far did the Cold War matter?", "Was it new?", "Why 1949?", "A bullet point question"],
  );
});

test("note blocks keep positions unless moved", () => {
  const saved = new Map<string, Saved>(
    [["a", "a0"], ["b", "a1"], ["c", "a2"]].map(([id, position]) => [id, { position, json: "", row: {} as Saved["row"] }]),
  );
  assert.deepEqual(positionsFor(["a", "b", "c"], saved), ["a0", "a1", "a2"]);
  const inserted = positionsFor(["a", "x", "b", "c"], saved);
  assert.equal(inserted[0], "a0");
  assert.ok(inserted[1] > "a0" && inserted[1] < "a1");
  const moved = positionsFor(["c", "a", "b"], saved);
  assert.ok(moved[0] < moved[1] && moved[1] < moved[2]);
  assert.equal(moved[2], "a1");
});

test("an edit sends only the columns it changed", () => {
  const before = { id: "r1", title: "Old", author: null, last_spot: { page: 2, frac: 0.1 }, modified_at: "a", seq: 4, deleted: false };
  assert.deepEqual(changedColumns(before, { ...before, last_spot: { page: 3, frac: 0.5 }, modified_at: "b" }), ["last_spot"]);
  assert.deepEqual(changedColumns(before, { ...before, author: undefined }), []);
  assert.deepEqual(changedColumns(before, { ...before, deleted: true }), ["deleted"]);
});

test("a line break in a transcript starts a paragraph and survives tidying", () => {
  assert.deepEqual(paragraphs("First point. Um, still first.\nSecond point."), ["First point. Um, still first.", "Second point."]);
  assert.equal(tidy("So um the the Concordat.\nNext."), "So the Concordat.\nNext.");
});

const app = (id: string, stage: string, next_deadline: string | null, applied = "2026-09-01", employer = id): ApplicationRow => ({
  id, employer, role: "", applied, stage, next_deadline, notes: null, file_cv: null, file_cl: null, file_rd: null, file_qs: null,
  modified_at: "", seq: 0, deleted: false,
});
// 3pm on 8 October 2026: a deadline today must not count as overdue.
const now = new Date(2026, 9, 8, 15, 0);

test("deadlines compare dates, not times", () => {
  assert.equal(deadlineState(app("a", "oa_todo", "2026-10-08"), now), "soon");
  assert.equal(deadlineWords(app("a", "oa_todo", "2026-10-08"), now), "today");
  assert.equal(deadlineState(app("a", "oa_todo", "2026-10-07"), now), "overdue");
  assert.equal(deadlineWords(app("a", "oa_todo", "2026-10-07"), now), "overdue by a day");
  assert.equal(deadlineWords(app("a", "oa_todo", "2026-10-05"), now), "overdue by 3 days");
  assert.equal(deadlineState(app("a", "oa_todo", "2026-10-15"), now), "soon");
  assert.equal(deadlineState(app("a", "oa_todo", "2026-10-16"), now), "none");
  assert.equal(deadlineWords(app("a", "oa_todo", "2026-10-09"), now), "tomorrow");
});

test("a closed application never shows its deadline as due", () => {
  assert.equal(deadlineState(app("a", "rejected", "2026-10-01"), now), "none");
  assert.equal(deadlineWords(app("a", "rejected", "2026-10-01"), now), "");
});

test("applications order by deadline, then open without one, then closed", () => {
  const list = [
    app("closed-new", "rejected", "2026-10-09", "2026-10-01"),
    app("no-deadline-old", "applied", null, "2026-08-01"),
    app("later", "interview_todo", "2026-11-01"),
    app("no-deadline-new", "applied", null, "2026-09-20"),
    app("sooner", "oa_todo", "2026-10-10"),
    app("closed-old", "withdrawn", null, "2026-07-01"),
  ];
  assert.deepEqual(sortApplications(list).map((a) => a.id), ["sooner", "later", "no-deadline-new", "no-deadline-old", "closed-new", "closed-old"]);
  assert.deepEqual(sortApplications(list, "employer").map((a) => a.id).slice(0, 2), ["closed-new", "closed-old"]);
});

test("dates show as 26 Feb 2026 and links get a scheme", () => {
  assert.equal(formatDate("2026-02-26"), "26 Feb 2026");
  assert.equal(formatDate(null), "");
  assert.equal(normaliseUrl("careers.kekst.com/apply"), "https://careers.kekst.com/apply");
  assert.equal(normaliseUrl("javascript:alert(1)"), null);
  const s = summarise([app("a", "oa_todo", "2026-10-07"), app("b", "offer", "2026-10-10"), app("c", "rejected", null)], now);
  assert.deepEqual(s, { open: 2, closed: 1, overdue: 1, soon: 1, offers: 1 });
});

test("every stage has a label and category, and each appears once in the grid", () => {
  assert.equal(STAGES.length, 20);
  for (const s of STAGES) {
    assert.ok(s.label && s.label.length > 0);
    assert.ok(["todo", "waiting", "offer", "closed"].includes(s.cat));
  }
  const gridKeys = STAGE_GRID.flatMap((row) => [row.todo, row.done, ...(row.extra ?? [])].filter((k): k is string => Boolean(k)));
  assert.equal(gridKeys.length, 20);
  const stageKeys = STAGES.map((s) => s.key);
  assert.deepEqual([...gridKeys].sort(), [...stageKeys].sort());

  assert.equal(stageOf("to_apply").cat, "todo");
  assert.equal(stageOf("written_todo").cat, "todo");
  assert.equal(stageOf("written_wait").cat, "waiting");
  assert.equal(stageOf("declined").cat, "closed");

  assert.equal(deadlineState(app("dec", "declined", "2026-10-01"), now), "none");

  assert.ok(matches(app("v", "hirevue_todo", null), "hirevue"));
  assert.ok(matches(app("o", "oa_todo", null), "oa"));

  const toApplyApp = app("apply-soon", "to_apply", "2026-10-09");
  const openApp = app("oa-later", "oa_todo", "2026-10-15");
  const closedApp = app("closed", "rejected", "2026-10-01");
  assert.deepEqual(sortApplications([closedApp, openApp, toApplyApp]).map((a) => a.id), ["apply-soon", "oa-later", "closed"]);
});

test("likely next stages match the progression table", () => {
  assert.deepEqual(likelyNextStages("to_apply"), ["applied"]);
  assert.deepEqual(likelyNextStages("applied"), ["oa_todo", "hirevue_todo", "interview_todo", "rejected"]);
  assert.deepEqual(likelyNextStages("oa_todo"), ["oa_wait"]);
  assert.deepEqual(likelyNextStages("oa_wait"), ["written_todo", "hirevue_todo", "interview_todo", "rejected"]);
  assert.deepEqual(likelyNextStages("written_todo"), ["written_wait"]);
  assert.deepEqual(likelyNextStages("written_wait"), ["hirevue_todo", "interview_todo", "ac_todo", "rejected"]);
  assert.deepEqual(likelyNextStages("hirevue_todo"), ["hirevue_wait"]);
  assert.deepEqual(likelyNextStages("hirevue_wait"), ["interview_todo", "ac_todo", "rejected"]);
  assert.deepEqual(likelyNextStages("interview_todo"), ["interview_wait"]);
  assert.deepEqual(likelyNextStages("interview_wait"), ["ac_todo", "final_todo", "offer", "rejected"]);
  assert.deepEqual(likelyNextStages("ac_todo"), ["ac_wait"]);
  assert.deepEqual(likelyNextStages("ac_wait"), ["final_todo", "offer", "rejected"]);
  assert.deepEqual(likelyNextStages("final_todo"), ["final_wait"]);
  assert.deepEqual(likelyNextStages("final_wait"), ["offer", "rejected"]);
  assert.deepEqual(likelyNextStages("offer"), ["accepted", "declined"]);
  assert.deepEqual(likelyNextStages("accepted"), []);
  assert.deepEqual(likelyNextStages("rejected"), []);
});

const ev = (
  id: string, stage: string, at: string, kind: "change" | "manual" = "change",
  from_stage: string | null = null, cleared_deadline: string | null = null,
  application_id = "a", deleted = false,
): ApplicationEventRow => ({
  id, application_id, stage, from_stage, at, kind, cleared_deadline,
  modified_at: "", seq: 0, deleted,
});

test("timeline order sorts by local time, including date-only entries and UTC timestamps", () => {
  const e1 = ev("e1", "applied", "2026-10-20");
  const e2 = ev("e2", "oa_todo", "2026-10-20T14:30:00.000Z");
  const e3 = ev("e3", "oa_wait", "2026-10-21");
  const e4 = ev("e4", "interview_todo", "2026-10-21T09:00:00.000Z");

  const sorted = sortEvents([e4, e1, e3, e2]);
  assert.deepEqual(sorted.map((e) => e.id), ["e1", "e2", "e3", "e4"]);

  // A UTC change at 23:30 UTC is 00:30 BST on 21 October in London, so a date-only
  // entry for 21 October (local midnight 00:00) comes first despite stored string prefixes.
  const dateOnly = ev("date-only", "applied", "2026-10-21");
  const midnightUtc = ev("midnight-utc", "oa_todo", "2026-10-20T23:30:00.000Z");
  assert.deepEqual(sortEvents([midnightUtc, dateOnly]).map((e) => e.id), ["date-only", "midnight-utc"]);

  const deletedEv = ev("e-del", "oa_todo", "2026-10-20T15:00:00.000Z", "change", null, null, "a", true);
  const testApp = app("a", "oa_wait", null, "2026-10-20");
  const timeline = getTimelineEntries(testApp, [e1, e2, deletedEv]);
  assert.deepEqual(timeline.map((e) => e.id), ["e1", "e2"]);

  const emptyApp = app("b", "applied", null, "2026-09-15");
  const fallback = getTimelineEntries(emptyApp, []);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].id, "virtual-applied-b");
  assert.equal(fallback[0].stage, "applied");
  assert.equal(fallback[0].at, "2026-09-15");
});

test("durations format in hours and days, and total days since applied", () => {
  assert.equal(formatDuration(0, 30 * 60 * 1000), "same day");
  assert.equal(formatDuration(0, 3 * 3600 * 1000), "3 hours");
  assert.equal(formatDuration(0, 3600 * 1000), "1 hour");
  assert.equal(formatDuration(0, 86400 * 1000), "1 day");
  assert.equal(formatDuration(0, 4 * 86400 * 1000), "4 days");
  assert.equal(formatDuration(0, 0, true, true), "same day");

  assert.equal(daysSinceApplied("2026-09-01", new Date(2026, 9, 8, 15, 0)), 37);
  assert.equal(daysSinceApplied(null, new Date(2026, 9, 8)), null);
  assert.equal(daysInStage("2026-10-01", new Date(2026, 9, 8, 15, 0)), 7);
});

test("mis-tap rule: first change adds, second within window amends, changing back removes", () => {
  const baseApp = app("a", "applied", null, "2026-10-01");
  const t0 = new Date("2026-10-20T10:00:00.000Z");

  const plan1 = evaluateStageChange(baseApp, [], "oa_todo", t0);
  assert.equal(plan1.action, "add");
  assert.equal(plan1.appUpdates.stage, "oa_todo");
  assert.equal(plan1.notice, "Stage changed to Online test: to complete.");
  assert.equal(plan1.eventChanges[0].table, "application_events");

  const e1 = ev("e1", "oa_todo", "2026-10-20T10:00:00.000Z", "change", "applied");
  const appAtOa = { ...baseApp, stage: "oa_todo" };

  const t1 = new Date("2026-10-20T10:02:00.000Z");
  const plan2 = evaluateStageChange(appAtOa, [e1], "written_todo", t1);
  assert.equal(plan2.action, "amend");
  assert.equal(plan2.appUpdates.stage, "written_todo");
  assert.equal((plan2.eventChanges[0].row as { id: string }).id, "e1");
  assert.equal((plan2.eventChanges[0].row as { stage: string }).stage, "written_todo");
  assert.ok(plan2.notice.includes("Written assessment: to complete, replacing the change at"));

  const e1Amended = { ...e1, stage: "written_todo" };
  const appAtWritten = { ...baseApp, stage: "written_todo" };

  const t2 = new Date("2026-10-20T10:03:00.000Z");
  const plan3 = evaluateStageChange(appAtWritten, [e1Amended], "applied", t2);
  assert.equal(plan3.action, "remove");
  assert.equal(plan3.appUpdates.stage, "applied");
  assert.equal((plan3.eventChanges[0].row as { id: string }).id, "e1");
  assert.equal((plan3.eventChanges[0].row as { deleted?: boolean }).deleted, true);
  assert.equal(plan3.notice, "Stage returned to Applied: awaiting response.");
});

test("mis-tap rule: progress in one sitting adds a new entry and clears deadline", () => {
  const appWithDeadline = app("a", "oa_todo", "2026-10-25", "2026-10-01");
  const e1 = ev("e1", "oa_todo", "2026-10-20T10:00:00.000Z", "change", "applied");
  const tNow = new Date("2026-10-20T10:05:00.000Z");

  const plan = evaluateStageChange(appWithDeadline, [e1], "oa_wait", tNow);
  assert.equal(plan.action, "add");
  assert.equal(plan.appUpdates.stage, "oa_wait");
  assert.equal(plan.appUpdates.next_deadline, null);
  assert.equal((plan.eventChanges[0].row as { cleared_deadline?: string }).cleared_deadline, "2026-10-25");
  assert.equal(plan.notice, "Stage changed to Online test: done, awaiting result.");

  // Undoing the change puts the cleared deadline back on next_deadline.
  const undoAdd = undoStageChangeChanges(plan.undo);
  assert.equal((undoAdd[0].row as { next_deadline?: string | null }).next_deadline, "2026-10-25");
  assert.equal((undoAdd[0].row as { stage?: string }).stage, "oa_todo");

  // Changing back within the window (remove action) restores the cleared deadline.
  const appAtWait = { ...appWithDeadline, stage: "oa_wait", next_deadline: null };
  const e2 = ev("e2", "oa_wait", "2026-10-20T10:05:00.000Z", "change", "oa_todo", "2026-10-25");
  const planBack = evaluateStageChange(appAtWait, [e1, e2], "oa_todo", new Date("2026-10-20T10:07:00.000Z"));
  assert.equal(planBack.action, "remove");
  assert.equal(planBack.appUpdates.stage, "oa_todo");
  assert.equal(planBack.appUpdates.next_deadline, "2026-10-25");
});

test("mis-tap rule: after window (11 minutes) adds rather than amends", () => {
  const appAtOa = app("a", "oa_todo", null, "2026-10-01");
  const e1 = ev("e1", "oa_todo", "2026-10-20T10:00:00.000Z", "change", "applied");
  const tLater = new Date("2026-10-20T10:11:00.000Z");

  const plan = evaluateStageChange(appAtOa, [e1], "written_todo", tLater);
  assert.equal(plan.action, "add");
});

test("mis-tap rule: manual last entry, stage changed elsewhere, and future time add", () => {
  const appAtOa = app("a", "oa_todo", null, "2026-10-01");

  const manualEv = ev("m1", "oa_todo", "2026-10-20T10:00:00.000Z", "manual", "applied");
  const plan1 = evaluateStageChange(appAtOa, [manualEv], "written_todo", new Date("2026-10-20T10:02:00.000Z"));
  assert.equal(plan1.action, "add");

  const e1 = ev("e1", "oa_todo", "2026-10-20T10:00:00.000Z", "change", "applied");
  const appMismatch = { ...appAtOa, stage: "interview_todo" };
  const plan2 = evaluateStageChange(appMismatch, [e1], "interview_wait", new Date("2026-10-20T10:02:00.000Z"));
  assert.equal(plan2.action, "add");

  const futureEv = ev("f1", "oa_todo", "2026-10-20T10:10:00.000Z", "change", "applied");
  const plan3 = evaluateStageChange(appAtOa, [futureEv], "written_todo", new Date("2026-10-20T10:00:00.000Z"));
  assert.equal(plan3.action, "add");
});

test("to_apply clears applied date, leaving to_apply fills applied date, changing back clears it", () => {
  const newApp = app("a", "applied", null, "2026-10-20");
  const e0 = ev("e0", "applied", "2026-10-20T10:00:00.000Z", "change", null);

  const t1 = new Date("2026-10-20T10:01:00.000Z");
  const plan1 = evaluateStageChange(newApp, [e0], "to_apply", t1);
  assert.equal(plan1.action, "amend");
  assert.equal(plan1.appUpdates.stage, "to_apply");
  assert.equal(plan1.appUpdates.applied, null);

  const appAtToApply = { ...newApp, stage: "to_apply", applied: null };
  const eToApply = ev("e0", "to_apply", "2026-10-20T10:00:00.000Z", "change", null);

  const t2 = new Date("2026-10-20T10:05:00.000Z");
  const plan2 = evaluateStageChange(appAtToApply, [eToApply], "applied", t2);
  assert.equal(plan2.action, "add");
  assert.equal(plan2.appUpdates.stage, "applied");
  assert.equal(plan2.appUpdates.applied, "2026-10-20");

  const appBackAtApplied = { ...appAtToApply, stage: "applied", applied: "2026-10-20" };
  const eApplied = ev("e1", "applied", "2026-10-20T10:05:00.000Z", "change", "to_apply");

  const t3 = new Date("2026-10-20T10:06:00.000Z");
  const plan3 = evaluateStageChange(appBackAtApplied, [eToApply, eApplied], "to_apply", t3);
  assert.equal(plan3.action, "remove");
  assert.equal(plan3.appUpdates.stage, "to_apply");
  assert.equal(plan3.appUpdates.applied, null);
});

test("undo restores application and events after add, amend, and remove", () => {
  const appBefore = app("a", "applied", "2026-10-25", "2026-10-01");
  const planAdd = evaluateStageChange(appBefore, [], "oa_todo", new Date("2026-10-20T10:00:00.000Z"));
  const undoAdd = undoStageChangeChanges(planAdd.undo);
  assert.equal(undoAdd[0].table, "applications");
  assert.equal((undoAdd[0].row as { stage: string }).stage, "applied");
  assert.equal((undoAdd[0].row as { next_deadline?: string | null }).next_deadline, "2026-10-25");
  assert.equal(undoAdd[1].table, "application_events");
  assert.equal((undoAdd[1].row as { deleted?: boolean }).deleted, true);

  const e1 = ev("e1", "oa_todo", "2026-10-20T10:00:00.000Z", "change", "applied");
  const appAtOa = { ...appBefore, stage: "oa_todo" };
  const planAmend = evaluateStageChange(appAtOa, [e1], "written_todo", new Date("2026-10-20T10:02:00.000Z"));
  const undoAmend = undoStageChangeChanges(planAmend.undo);
  assert.equal((undoAmend[0].row as { stage: string }).stage, "oa_todo");
  assert.equal((undoAmend[0].row as { next_deadline?: string | null }).next_deadline, "2026-10-25");
  assert.equal((undoAmend[1].row as { stage: string }).stage, "oa_todo");

  const planRemove = evaluateStageChange(appAtOa, [e1], "applied", new Date("2026-10-20T10:03:00.000Z"));
  const undoRemove = undoStageChangeChanges(planRemove.undo);
  assert.equal((undoRemove[0].row as { stage: string }).stage, "oa_todo");
  assert.equal((undoRemove[0].row as { next_deadline?: string | null }).next_deadline, "2026-10-25");
  assert.equal((undoRemove[1].row as { deleted?: boolean }).deleted, false);
});

test("events to restore brings back events deleted with the application, not earlier ones", () => {
  const appModifiedAt = "2026-10-20T10:00:00.000Z";
  // Event removed earlier by hand (modified before application was deleted).
  const earlierRemoved = {
    ...ev("e-earlier", "oa_todo", "2026-10-18T09:00:00.000Z", "change", "applied", null, "a", true),
    modified_at: "2026-10-18T09:30:00.000Z",
  };
  // Event deleted in the same commit as the application (modified_at is >= app.modified_at).
  const deletedWithApp = {
    ...ev("e-with-app", "oa_wait", "2026-10-20T09:55:00.000Z", "change", "oa_todo", null, "a", true),
    modified_at: "2026-10-20T10:00:00.002Z",
  };
  // Event that was never deleted.
  const activeEvent = {
    ...ev("e-active", "interview_todo", "2026-10-20T10:00:00.000Z", "change", "oa_wait", null, "a", false),
    modified_at: "2026-10-20T10:00:00.002Z",
  };

  const toRestore = eventsToRestore([earlierRemoved, deletedWithApp, activeEvent], appModifiedAt);
  assert.deepEqual(toRestore.map((e) => e.id), ["e-with-app"]);
});

test("a page range with no source is read as pages, with a source as both", () => {
  const chapter = parseTitle("(AT1) Broers, M. (1996) 'Europe under Napoleon, 1799-1815', pp. 1-24");
  assert.equal(chapter.pages, "1-24");
  assert.equal(chapter.source, undefined);
  assert.equal(chapter.title, "Europe under Napoleon, 1799-1815");
  const article = parseTitle("(AT2) Dwyer, P. (2002) 'Napoleon and the Drive for Glory', French History 16, pp. 379-403");
  assert.equal(article.source, "French History 16");
  assert.equal(article.pages, "379-403");
  const book = parseTitle("(AT3) Grab, A. (2003) 'Napoleon and the Transformation of Europe', Palgrave");
  assert.equal(book.source, "Palgrave");
  assert.equal(book.pages, undefined);
});

test("pasted questions lose every kind of numbering, but not a year", () => {
  assert.deepEqual(
    splitQuestions("Question 1: How far was it new?\na) Was the Concordat a tool?\n(3) Why Brumaire?\n\u2022 A bulleted one?\n1949 was the turning point?"),
    ["How far was it new?", "Was the Concordat a tool?", "Why Brumaire?", "A bulleted one?", "1949 was the turning point?"],
  );
});

// Text layout for an OCR layer, as JSTOR lays over a scan: words one at a
// time with jittered baselines and guessed sizes and widths, a Keywords box
// beside the abstract, hyphens dropped at line ends, note numbers stuck to
// the text, and JSTOR's download footer.
{
  const name = "an OCR layer reads in order, with its box apart and split words rejoined";
  try {
    const { readFileSync } = await import("node:fs");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { reflow } = await import("../src/lib/reflow");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(new URL("./fixtures/ocr-layer.pdf", import.meta.url))), verbosity: 0 }).promise;
    const out = await reflow(doc as never);
    const blocks = out.blocks.map((b) => b.lines.map((l, i) => {
      const t = l.hyphen ? l.text.replace(/-\s*$/, "") : l.text.trim();
      return t + (i < b.lines.length - 1 && !l.hyphen && !l.glue ? " " : "");
    }).join("").replace(/\s+/g, " "));
    const all = blocks.join("\n");
    assert.ok(all.includes("Edward Grey for contributing to the escalation of the July Crisis"), "the abstract keeps its order:\n" + all.slice(0, 400));
    const keywords = blocks.find((b) => b.startsWith("KEYWORDS"));
    assert.ok(keywords && keywords.includes("British foreign policy; July Crisis; origins of First World War"), "the box is read whole: " + keywords);
    assert.ok(blocks.indexOf(keywords!) > blocks.findIndex((b) => b.includes("sets out to explain")), "the box comes after the abstract");
    assert.ok(all.includes("many historians agree"), "a word split across lines is rejoined");
    assert.ok(all.includes("a mistaken view"), "a short first half is rejoined");
    assert.ok(all.includes("'men of 1914', rather"), "a stuck note number is left out");
    assert.ok(!all.includes("This content downloaded"), "the download footer is left out");
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n${(error as Error).message}`);
  }
}

{
  const name = "reflow strips rotated watermarks, publisher footers and detects section headings";
  try {
    const { reflow } = await import("../src/lib/reflow");
    const mockDoc = {
      numPages: 1,
      getPage: async () => ({
        getViewport: () => ({ width: 600, height: 800 }),
        getTextContent: async () => ({
          items: [
            // Rotated watermark (should be filtered out)
            { str: "WATERMARK_SPURIOUS", transform: [0, 10, -10, 0, 10, 400], width: 100, height: 10 },
            // Section heading (all-caps, isolated)
            { str: "I. INTRODUCTION", transform: [14, 0, 0, 14, 200, 720], width: 150, height: 14 },
            // Body text lines
            { str: "This is the first sentence of the article.", transform: [10, 0, 0, 10, 50, 680], width: 200, height: 10 },
            { str: "And here is the second sentence that completes the paragraph.", transform: [10, 0, 0, 10, 50, 668], width: 300, height: 10 },
            // Footnote at bottom of page
            { str: "1. See Edward Grey, Speeches (London, 1915).", transform: [8, 0, 0, 8, 50, 100], width: 250, height: 8 },
            // Multi-line publisher footer
            { str: "Downloaded from https://academic.oup.com/terms by LSE Library", transform: [8, 0, 0, 8, 50, 40], width: 300, height: 8 },
          ],
        }),
      }),
    };
    const out = await reflow(mockDoc as never);
    const headings = out.blocks.filter((b) => b.kind === "heading");
    const paras = out.blocks.filter((b) => b.kind === "para");
    const notes = out.blocks.filter((b) => b.kind === "note");

    assert.equal(headings.length, 1);
    assert.ok(headings[0].lines[0].text.includes("I. INTRODUCTION"));
    assert.equal(paras.length, 1);
    assert.ok(paras[0].lines[0].text.includes("This is the first sentence"));
    assert.equal(notes.length, 1);
    assert.ok(notes[0].lines[0].text.includes("1. See Edward Grey"));

    // Watermark and download footer should be completely dropped
    const allText = out.blocks.map((b) => b.lines.map((l) => l.text).join(" ")).join(" ");
    assert.ok(!allText.includes("WATERMARK_SPURIOUS"));
    assert.ok(!allText.includes("Downloaded from https://academic.oup.com"));

    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n${(error as Error).message}`);
  }
}

test("a highlight is drawn as one band per line, the lines meeting", () => {
  // Two lines of three words each, with OCR-wide gaps between the words and
  // leading between the lines.
  const words = [[72, 700, 110, 710], [118, 700, 160, 710], [170, 700, 220, 710], [72, 686, 100, 696], [109, 686, 150, 696], [158, 686, 190, 696]];
  const bands = smoothRects(words);
  assert.equal(bands.length, 2);
  assert.deepEqual([bands[0][0], bands[0][2]], [72, 220]);
  assert.deepEqual([bands[1][0], bands[1][2]], [72, 190]);
  // The two bands meet: no stripe between the lines.
  assert.equal(bands[0][1], bands[1][3]);
  assert.equal(bands[0][1], 698);
});

test("each stage tile in the stage card is named for its step, short enough to fit", () => {
  assert.equal(stageShort("oa_todo"), "To complete");
  assert.equal(stageShort("oa_wait"), "Awaiting result");
  assert.equal(stageShort("interview_todo"), "To attend");
  assert.equal(stageShort("hirevue_todo"), "To record");
  assert.equal(stageShort("applied"), "Awaiting response");
  assert.equal(stageShort("offer"), "To accept or decline");
  assert.equal(stageShort("accepted"), "Accepted");
  assert.equal(stageShort("rejected"), "Rejected");
  // Every stage in the grid has words for its tile.
  for (const row of STAGE_GRID) for (const key of [row.todo, row.done, ...(row.extra ?? [])].filter(Boolean) as string[]) {
    assert.ok(stageShort(key).length > 0 && stageShort(key).length <= 22, key);
  }
});

test("a step's length counts calendar days when either end is a date alone", () => {
  // 10 Oct to 17 Oct at 14:30 is a week, not eight days.
  assert.equal(stepLength("2026-10-10", "2026-10-17T13:30:00.000Z"), "7 days");
  assert.equal(stepLength("2026-10-10", "2026-10-11"), "1 day");
  assert.equal(stepLength("2026-10-10", "2026-10-10T09:00:00.000Z"), "same day");
  // Across the clocks going back on 25 October, still whole days.
  assert.equal(stepLength("2026-10-24", "2026-10-26"), "2 days");
  // Between two times, hours on the same day.
  assert.equal(stepLength("2026-10-20T09:00:00.000Z", "2026-10-20T12:00:00.000Z"), "3 hours");
});

test("time in the current stage comes from its latest entry, and says nothing without one", () => {
  const app = { id: "a", employer: "PwC", role: "", applied: "2026-10-01", stage: "oa_todo", next_deadline: null, notes: null,
    file_cv: null, file_cl: null, file_rd: null, file_qs: null, modified_at: "2026-10-01T00:00:00.000Z", seq: 0, deleted: false };
  const ev = (id: string, stage: string, at: string) => ({ id, application_id: "a", stage, from_stage: null, at, kind: "change" as const,
    cleared_deadline: null, modified_at: at, seq: 0, deleted: false });
  const events = [ev("1", "applied", "2026-10-01"), ev("2", "oa_todo", "2026-10-10T14:30:00.000Z")];
  assert.equal(currentStageSince(app, events), "2026-10-10T14:30:00.000Z");
  assert.equal(entryDate("2026-10-10T14:30:00.000Z"), "2026-10-10");
  assert.equal(inStageWords("2026-10-10T14:30:00.000Z", new Date(2026, 9, 20, 9)), "for 10 days");
  assert.equal(inStageWords("2026-10-20", new Date(2026, 9, 20, 18)), "since today");
  assert.equal(inStageWords("2026-10-19", new Date(2026, 9, 20, 18)), "for 1 day");
  // Changed on a device without the timeline: the latest entry is another stage, so no "since".
  assert.equal(currentStageSince({ ...app, stage: "oa_wait" }, events), null);
  assert.equal(inStageWords(null), "");
});

test("the Applied date and the first Applied entry move together", () => {
  const app = { id: "a", employer: "PwC", role: "", applied: "2026-10-01", stage: "oa_todo", next_deadline: null, notes: null,
    file_cv: null, file_cl: null, file_rd: null, file_qs: null, modified_at: "2026-10-01T00:00:00.000Z", seq: 0, deleted: false };
  const ev = (id: string, stage: string, at: string, kind: "change" | "manual" = "change") => ({ id, application_id: "a", stage, from_stage: null, at, kind,
    cleared_deadline: null, modified_at: at, seq: 0, deleted: false });
  const events = [ev("first", "applied", "2026-10-01T10:00:00.000Z"), ev("oa", "oa_todo", "2026-10-08")];
  assert.equal(firstAppliedEntry(events)?.id, "first");
  // Changing the Applied date moves the first Applied entry, which then counts as edited by hand.
  const moved = appliedDateChanges(app, events, "2026-09-28");
  assert.equal(moved.length, 2);
  assert.deepEqual(moved[1].row, { id: "first", at: "2026-09-28", kind: "manual" });
  // The same day changes only the application, and clearing the date leaves the entry alone.
  assert.equal(appliedDateChanges(app, events, "2026-10-01").length, 1);
  assert.equal(appliedDateChanges(app, events, null).length, 1);
  // Editing the first Applied entry's date changes the Applied date; editing any other entry does not.
  const edited = entryEditChanges(app, events, events[0], { stage: "applied", at: "2026-09-30" });
  assert.deepEqual(edited.map((c) => c.table), ["application_events", "applications"]);
  assert.deepEqual(edited[1].row, { id: "a", applied: "2026-09-30" });
  assert.equal(entryEditChanges(app, events, events[1], { stage: "oa_todo", at: "2026-10-09" }).length, 1);
  // Turning the first entry into another stage leaves the Applied date as it was.
  assert.equal(entryEditChanges(app, events, events[0], { stage: "to_apply", at: "2026-09-30" }).length, 1);
  // A deleted entry is never the first.
  assert.equal(firstAppliedEntry([{ ...events[0], deleted: true }, events[1]]), undefined);
});

test("slides are named for their place, and numbered when a session has more than one", () => {
  const week = { term: "AT" as const, number: 4, title: "The Anglo-Japanese Alliance" };
  assert.equal(slidesBase("HY248", week, "lecture"), "HY248 AT4 Lecture slides");
  assert.equal(slidesBase("HY248", week, "seminar"), "HY248 AT4 Seminar slides");
  assert.equal(slidesBase("HY248", week, "combined"), "HY248 AT4 slides");
  assert.equal(slidesBase("HY248", week, null), "HY248 AT4 slides");
  // A dissertation's section is named by its own name.
  assert.equal(slidesBase("HY300", { term: "S" as const, number: 2, title: "Literature review" }, "supervision"), "HY300 Literature review Supervision slides");
  assert.equal(freeName("HY248 AT4 Lecture slides", []), "HY248 AT4 Lecture slides");
  assert.equal(freeName("HY248 AT4 Lecture slides", ["HY248 AT4 Lecture slides"]), "HY248 AT4 Lecture slides 2");
  // A gap left by a deleted deck is filled, rather than a name used twice.
  assert.equal(freeName("B", ["B", "B 3"]), "B 2");
  assert.ok(isPlaceName("HY248 AT4 Lecture slides 2", "HY248 AT4 Lecture slides"));
  assert.ok(!isPlaceName("My own name for these", "HY248 AT4 Lecture slides"));
  // Characters in a module code are taken literally, never as a pattern.
  assert.ok(!isPlaceName("HY248xAT4 Lecture slides", "HY248.AT4 Lecture slides"));
});

test("a deck still carrying its file's name is told apart from one you named", () => {
  const given = fileGivenTitle("lecture-week-3-slides.pptx");
  assert.ok(given.includes("lecture-week-3-slides"));
  assert.ok(!given.includes("Week 3, the treaty ports"));
  assert.deepEqual(fileGivenTitle(null), []);
});

test("downloads are named for what they are, safely on any computer", () => {
  assert.equal(safeFileName("HY248 AT4: Lecture / slides?", "pdf"), "HY248 AT4 Lecture slides.pdf");
  assert.equal(safeFileName("Chen (2001) \u2018Introduction\u2019.", "pdf"), "Chen (2001) 'Introduction'.pdf");
  assert.equal(safeFileName("   ", "pdf"), "file.pdf");
  assert.ok(safeFileName("x".repeat(300), "pdf").length <= 124);
  assert.equal(extensionFor("audio/ogg; codecs=opus", null), "ogg");
  assert.equal(extensionFor("application/pdf", "Lecture 1.PPTX"), "pptx");
  assert.equal(extensionFor(null, null), "pdf");
  const reading = { kind: "secondary" as const, author: "Chen, J.", year: 2001, title: "Introduction", source: "in Mao's China and the Cold War", pages: "1-16", doc_date: null };
  assert.equal(readingFileName(reading, { mime: "application/pdf", original_name: "(AT1) Chen, J. (2001) 'Introduction', in Mao's China.pdf" }), "Chen (2001) 'Introduction'.pdf");
  const slides = { ...reading, kind: "slides" as const, title: "HY248 AT4 Lecture slides" };
  assert.equal(readingFileName(slides, { mime: "application/pdf", original_name: "lecture-week-4.pptx" }), "HY248 AT4 Lecture slides.pptx");
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall web tests passed");
