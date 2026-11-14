// Minimal test runner: npm test
process.env.TZ = "Europe/London";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keyBetween, keysAfter } from "../src/lib/keys";
import { slidesBase, isPlaceName, freeName, fileGivenTitle, safeFileName, extensionFor, readingFileName, splitFileName, truncateMiddle } from "../src/lib/names";
import { parseTitle } from "../src/lib/parse";
import { fullTitle, shortTitle, chicagoBibliography, chicagoNote, parsePeople } from "../src/lib/titles";
import { isDissertation, isLibrary, hasCustomSections, isSyllabus, moduleHasNotes, moduleHasSessions, moduleHasMeetings, coverLabel } from "../src/lib/sections";
import { todayLocal, parseISO, formatISO, daysInMonth, addDays, addMonths, weekdayMon0, nextMonday, monthGrid, parseUK, formatLong, chosenDateText } from "../src/lib/civilDate";
import { parseRoute } from "../src/lib/router";
import { notesQueue } from "../src/lib/notesQueue";

import { notesLabel } from "../src/lib/modules";
import { storedAccent, ACCENTS } from "../src/lib/appearance";
import { crc32, createZip } from "../src/lib/zip";
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
import { registerCssVarTests } from "./test_css_vars";
import { registerProgressTests } from "./test_progress";
import { registerSheetRouteTests } from "./test_sheet";
import { registerJobLogicTests } from "./test_job_logic";
import { registerSafetyTests } from "./test_safety";
import { registerNotesAndReadingsTests } from "./test_notes_and_readings";
import { dismissTopLayer } from "../src/lib/layers";
import { coverShape, defaultViewMode, isTileMode, parseViewMode, VIEW_MODES, viewSettingKey } from "../src/lib/views";
import { videoFrameTime } from "../src/lib/videoThumbs";
import { estimatedSizes, sameSize, shouldStream, STREAM_FROM_BYTES } from "../src/lib/pdfOpen";
import { viaLabel } from "../src/lib/citations";
import { foldedBlockIds, foldStyles } from "../src/lib/folds";
import { draftExcerpt, wordProgress } from "../src/lib/assessment";
import { repairText, searchFold } from "../src/lib/textnorm";
import { isAssessmentEnabled } from "../src/lib/assessmentEnabled";
import { describeDeadline, pickNextDeadline } from "../src/lib/jobsCard";
import { INSETS_COMPACT, INSETS_REGULAR, parseChrome, dockGeometry, editorQuery, FILE_TAB_COVER, FALLBACK_STATUS_HEIGHT } from "../src/lib/wordcraftChrome";
import { registerListenTests } from "./test_listen";

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
registerCssVarTests(test);
registerProgressTests(test);
registerSheetRouteTests(test);
registerJobLogicTests(test);
registerSafetyTests(test);
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

{
  const name = "reflow preserves margin text with body spacing, joins sentences across page turns, and respects abbreviations";
  try {
    const { reflow } = await import("../src/lib/reflow");
    const mockDoc = {
      numPages: 2,
      getPage: async (n: number) => {
        if (n === 1) {
          return {
            getViewport: () => ({ width: 600, height: 800 }),
            getTextContent: async () => ({
              items: [
                // Isolated running head at y=760 (height=800, gap to text is 25pt > 1.6*13)
                { str: "THE JULY CRISIS OF 1914", transform: [10, 0, 0, 10, 200, 760], width: 160, height: 10 },
                // First line of body at y=735 (91.8% of page height, short opening line < 110 chars)
                { str: "In July 1914, tensions grew across Europe as", transform: [10, 0, 0, 10, 50, 735], width: 280, height: 10 },
                // Second line at normal leading (y=722, gap 13pt)
                { str: "The foreign minister consulted Dr.", transform: [10, 0, 0, 10, 50, 722], width: 220, height: 10 },
                // Third line: abbreviation Dr. at end of line 2 must not break paragraph
                { str: "Smith regarding the ultimatum and", transform: [10, 0, 0, 10, 50, 709], width: 200, height: 10 },
                // Fourth line ending with hyphen
                { str: "the response was immediate and unprec-", transform: [10, 0, 0, 10, 50, 696], width: 260, height: 10 },
                // Fifth line
                { str: "edented in scale, and diplomatic", transform: [10, 0, 0, 10, 50, 683], width: 240, height: 10 },
                // Sixth line continuing across page turn
                { str: "Negotiations continued throughout the week without pause.", transform: [10, 0, 0, 10, 50, 670], width: 340, height: 10 },
                // Isolated page number at bottom y=20 (isolated by 650pt gap)
                { str: "1", transform: [10, 0, 0, 10, 300, 20], width: 10, height: 10 },
              ],
            }),
          };
        } else {
          return {
            getViewport: () => ({ width: 600, height: 800 }),
            getTextContent: async () => ({
              items: [
                // Top margin body line on page 2 at y=735 (91.8% of height) continuing paragraph
                { str: "Eventually, the final decision was reached.", transform: [10, 0, 0, 10, 50, 735], width: 270, height: 10 },
                { str: "Peace was preserved for the moment.", transform: [10, 0, 0, 10, 50, 722], width: 250, height: 10 },
                // Indented new paragraph on page 2 at x=75 (colLeft is 50, so indented by 25pt)
                { str: "A new era began immediately after the treaty.", transform: [10, 0, 0, 10, 75, 71], width: 300, height: 10 },
                { str: "The concluding sentence was brief and", transform: [10, 0, 0, 10, 50, 58], width: 240, height: 10 },
                // Bottom margin line on page 2 at y=45 (5.6% of page height, short line < 40 chars)
                { str: "decisive in tone.", transform: [10, 0, 0, 10, 50, 45], width: 110, height: 10 },
                // Isolated page number
                { str: "2", transform: [10, 0, 0, 10, 300, 20], width: 10, height: 10 },
              ],
            }),
          };
        }
      },
    };

    const out = await reflow(mockDoc as never);
    const paras = out.blocks.filter((b) => b.kind === "para");
    const allText = paras.map((p) => p.lines.map((l) => l.text).join(" ")).join("\n");

    // Running head and page numbers must be stripped
    assert.ok(!allText.includes("THE JULY CRISIS"));
    assert.ok(!allText.includes("\n1\n") && !allText.includes("\n2\n"));

    // Margin text must be preserved
    assert.ok(allText.includes("In July 1914, tensions grew across Europe as"), "top margin opening line preserved");
    assert.ok(allText.includes("edented in scale, and diplomatic"), "bottom margin concluding line preserved");
    assert.ok(allText.includes("Negotiations continued"), "top margin line on page 2 preserved");

    // Abbreviation Dr. must not break paragraph
    assert.ok(paras[0].lines.some((l) => l.text.includes("Dr.")) && paras[0].lines.some((l) => l.text.includes("Smith regarding")), "abbreviation keeps sentence in same paragraph");

    // Hyphenation: line with unprec- must have hyphen flag
    const hyphenLine = paras[0].lines.find((l) => l.text.includes("unprec-"));
    assert.ok(hyphenLine && hyphenLine.hyphen, "line ending in hyphen is flagged");

    // New indented paragraph on page 2 must be a separate block
    assert.equal(paras.length, 2, "indented paragraph on page 2 starts a new paragraph block");
    assert.ok(paras[1].lines[0].text.includes("A new era began"), "second paragraph content matches");

    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n${(error as Error).message}`);
  }
}

{
  const name = "reflow handles soft hyphens, avoids breaks before lowercase lines, and separates list items";
  try {
    const { reflow } = await import("../src/lib/reflow");
    const mockDoc = {
      numPages: 1,
      getPage: async () => ({
        getViewport: () => ({ width: 600, height: 800 }),
        getTextContent: async () => ({
          items: [
            // Soft hyphen at end of line
            { str: "The cabinet reached an agree\u00ad", transform: [10, 0, 0, 10, 50, 700], width: 220, height: 10 },
            // Lowercase continuation
            { str: "ment after lengthy debate.", transform: [10, 0, 0, 10, 50, 687], width: 180, height: 10 },
            // Stray period at end of line followed by lowercase word
            { str: "The treaty was ratified in June .", transform: [10, 0, 0, 10, 50, 674], width: 200, height: 10 },
            { str: "and welcomed by the citizens.", transform: [10, 0, 0, 10, 50, 661], width: 190, height: 10 },
            // List items
            { str: "1. The first resolution called for disarmament.", transform: [10, 0, 0, 10, 50, 630], width: 280, height: 10 },
            { str: "2. The second resolution established borders.", transform: [10, 0, 0, 10, 50, 600], width: 270, height: 10 },
          ],
        }),
      }),
    };
    const out = await reflow(mockDoc as never);
    const paras = out.blocks.filter((b) => b.kind === "para");

    // Soft hyphen flagged
    const softHyphenLine = paras[0].lines.find((l) => l.text.includes("agree"));
    assert.ok(softHyphenLine && softHyphenLine.hyphen, "soft hyphen is flagged");

    // Lowercase line continuation after stray period must not split paragraph
    assert.ok(paras[0].lines.some((l) => l.text.includes("ratified")) && paras[0].lines.some((l) => l.text.includes("welcomed by")), "lowercase start keeps sentence in same paragraph");

    // List items are separate paragraphs
    assert.ok(paras.some((p) => p.lines[0].text.startsWith("1.")), "item 1 is a block");
    assert.ok(paras.some((p) => p.lines[0].text.startsWith("2.")), "item 2 is a block");
    assert.equal(paras.length, 3, "body text plus 2 list items equals 3 paragraphs");

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

test("module kinds distinguish taught, dissertation and library modules", () => {
  assert.equal(isDissertation({ kind: "dissertation" }), true);
  assert.equal(isDissertation({ kind: "taught" }), false);
  assert.equal(isDissertation({ kind: "library" }), false);
  assert.equal(isDissertation(null), false);

  assert.equal(isLibrary({ kind: "library" }), true);
  assert.equal(isLibrary({ kind: "taught" }), false);
  assert.equal(isLibrary({ kind: "dissertation" }), false);
  assert.equal(isLibrary(null), false);

  assert.equal(hasCustomSections({ kind: "library" }), true);
  assert.equal(hasCustomSections({ kind: "dissertation" }), true);
  assert.equal(hasCustomSections({ kind: "taught" }), false);
  assert.equal(hasCustomSections(null), false);

  assert.equal(moduleHasNotes({ kind: "taught" }), true);
  assert.equal(moduleHasNotes({ kind: "dissertation" }), true);
  assert.equal(moduleHasNotes({ kind: "library" }), false);

  assert.equal(moduleHasSessions({ kind: "taught" }), true);
  assert.equal(moduleHasSessions({ kind: "dissertation" }), true);
  assert.equal(moduleHasSessions({ kind: "library" }), false);

  assert.equal(moduleHasMeetings({ kind: "taught" }), false);
  assert.equal(moduleHasMeetings({ kind: "dissertation" }), true);
  assert.equal(moduleHasMeetings({ kind: "library" }), false);

  assert.equal(isSyllabus({ term: "AT", number: 0 }), true);
  assert.equal(isSyllabus({ term: "S", number: 1, title: "Syllabus & Admin" }), true);
  assert.equal(isSyllabus({ term: "S", number: 2, title: "Course Materials" }), true);
  assert.equal(isSyllabus({ term: "S", number: 1, title: "Chapter 1" }), false);
  assert.equal(isSyllabus({ term: "AT", number: 1 }), false);
});

test("notesLabel formats session notes titles and avoids double 'notes'", () => {
  // Untitled lecture:
  assert.equal(notesLabel({ kind: "lecture", title: "" }, false), "Add lecture notes");
  assert.equal(notesLabel({ kind: "lecture", title: null }, false), "Add lecture notes");
  assert.equal(notesLabel({ kind: "lecture", title: "   " }, false), "Add lecture notes");
  assert.equal(notesLabel({ kind: "lecture", title: "" }, true), "Lecture notes");
  assert.equal(notesLabel({ kind: "lecture", title: null }, true), "Lecture notes");
  assert.equal(notesLabel({ kind: "lecture", title: "   " }, true), "Lecture notes");

  // Untitled seminar:
  assert.equal(notesLabel({ kind: "seminar", title: "" }, false), "Add seminar notes");
  assert.equal(notesLabel({ kind: "seminar", title: "" }, true), "Seminar notes");

  // Titled session without "notes":
  assert.equal(notesLabel({ kind: "lecture", title: "Bismarck and Europe" }, false), "Add Bismarck and Europe notes");
  assert.equal(notesLabel({ kind: "lecture", title: "Bismarck and Europe" }, true), "Bismarck and Europe notes");

  // Titled session ending in "notes":
  assert.equal(notesLabel({ kind: "seminar", title: "Seminar Notes" }, false), "Add Seminar Notes");
  assert.equal(notesLabel({ kind: "seminar", title: "Seminar Notes" }, true), "Seminar Notes");
  assert.equal(notesLabel({ kind: "lecture", title: "Reading notes" }, false), "Add Reading notes");
  assert.equal(notesLabel({ kind: "lecture", title: "Reading notes" }, true), "Reading notes");

  // Leading "Notes" or trailing punctuation:
  assert.equal(notesLabel({ kind: "lecture", title: "Notes on Bismarck" }, false), "Add Notes on Bismarck");
  assert.equal(notesLabel({ kind: "lecture", title: "Notes on Bismarck" }, true), "Notes on Bismarck");
  assert.equal(notesLabel({ kind: "lecture", title: "Lecture notes." }, false), "Add Lecture notes");
  assert.equal(notesLabel({ kind: "lecture", title: "Lecture notes." }, true), "Lecture notes");

  // Word containing "notes" as substring (e.g. Footnotes):
  assert.equal(notesLabel({ kind: "lecture", title: "Footnotes" }, false), "Add Footnotes notes");
  assert.equal(notesLabel({ kind: "lecture", title: "Footnotes" }, true), "Footnotes notes");

  // Title of only whitespace and punctuation:
  assert.equal(notesLabel({ kind: "lecture", title: "   ...   " }, false), "Add lecture notes");
  assert.equal(notesLabel({ kind: "lecture", title: "   ...   " }, true), "Lecture notes");
});

test("top bar brand maintains distinct styling without selector interference", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.ok(/\.brand\s*\{[^}]*font-weight:\s*600/.test(css), "brand must have font-weight: 600");
  assert.ok(/\.brand\s*\{[^}]*font-size:\s*1\.15rem/.test(css), "brand must have font-size: 1.15rem");
});

test("accent palette defines valid palettes and defaults to oxford", () => {
  assert.equal(storedAccent(), "oxford");
  assert.equal(ACCENTS.length, 5);
  const values = ACCENTS.map((a) => a.value);
  assert.deepEqual(values, ["oxford", "sage", "amber", "burgundy", "slate"]);
});

test("zip builder creates valid zip bytes with crc32", () => {
  const enc = new TextEncoder();
  const sample = enc.encode("hello world");
  assert.equal(crc32(sample), 0x0d4a1185);

  const zip = createZip([
    { name: "test.txt", data: sample },
    { name: "sub/notes.md", data: enc.encode("# Notes") },
  ]);
  assert.ok(zip.length > sample.length);
  // Valid ZIP header starts with PK\x03\x04
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  assert.equal(zip[2], 0x03);
  assert.equal(zip[3], 0x04);
});

test("splitFileName splits stem and extension correctly", () => {
  assert.deepEqual(splitFileName("document.pdf"), { stem: "document", ext: ".pdf" });
  assert.deepEqual(splitFileName("archive.tar.gz"), { stem: "archive.tar", ext: ".gz" });
  assert.deepEqual(splitFileName(".env"), { stem: ".env", ext: "" });
  assert.deepEqual(splitFileName("noextension"), { stem: "noextension", ext: "" });
  assert.deepEqual(splitFileName("file.verylongextension"), { stem: "file.verylongextension", ext: "" });
});

test("truncateMiddle truncates long filenames while preserving extension", () => {
  assert.equal(truncateMiddle("short.pdf", 20), "short.pdf");
  const truncated = truncateMiddle("a_very_long_document_name_final_version.docx", 20);
  assert.ok(truncated.endsWith(".docx"));
  assert.ok(truncated.includes("\u2026"));
  assert.ok(truncated.length <= 20);
});

test("coverLabel returns title when present, or falls back to section/shelf/code", () => {
  assert.equal(coverLabel({ title: "My Special Topic", code: "AT1", number: 1 }, "week"), "My Special Topic");
  assert.equal(coverLabel({ title: "", code: "AT1", number: 1 }, "week"), "AT1");
  assert.equal(coverLabel({ title: null, code: "S1", number: 2 }, "section"), "Section 2");
  assert.equal(coverLabel({ title: null, code: "S1", number: 3 }, "shelf"), "Shelf 3");
  assert.equal(coverLabel({ title: "  ", code: null, number: 4 }, "week"), "Week 4");
});

test("civilDate parseISO and formatISO handle bounds and validity", () => {
  assert.deepEqual(parseISO("2026-06-15"), { year: 2026, month: 6, day: 15 });
  assert.equal(formatISO(2026, 6, 15), "2026-06-15");
  assert.equal(parseISO("2026-02-29"), null); // not a leap year
  assert.deepEqual(parseISO("2028-02-29"), { year: 2028, month: 2, day: 29 }); // leap year
  assert.equal(parseISO("2100-02-29"), null); // 2100 is not a leap year in Gregorian calendar
  assert.equal(parseISO("1899-12-31"), null); // below min year
  assert.equal(parseISO("2200-01-01"), null); // above max year
  assert.equal(parseISO("not-a-date"), null);
});

test("civilDate todayLocal produces a valid ISO string", () => {
  const today = todayLocal();
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(today));
  assert.ok(parseISO(today) !== null);
});

test("civilDate addDays and addMonths handle month-end clamping and bounds", () => {
  assert.equal(addDays("2026-06-15", 1), "2026-06-16");
  assert.equal(addDays("2026-06-15", -1), "2026-06-14");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(addMonths("2100-01-31", 1), "2100-02-28");
  assert.equal(addMonths("2026-03-31", -1), "2026-02-28");
});

test("civilDate weekdayMon0 and nextMonday", () => {
  // 2026-06-15 is a Monday
  assert.equal(weekdayMon0("2026-06-15"), 0);
  assert.equal(weekdayMon0("2026-06-21"), 6); // Sunday
  // nextMonday strictly after today: on Monday, next Monday is 7 days ahead
  assert.equal(nextMonday("2026-06-15"), "2026-06-22");
  // on Sunday 2026-06-21, next Monday is tomorrow
  assert.equal(nextMonday("2026-06-21"), "2026-06-22");
  // on Tuesday 2026-06-16, next Monday is 6 days ahead
  assert.equal(nextMonday("2026-06-16"), "2026-06-22");
});

test("civilDate monthGrid returns fixed 42-cell array starting on Monday", () => {
  const grid = monthGrid(2026, 6);
  assert.equal(grid.length, 42);
  assert.equal(weekdayMon0(grid[0].iso), 0); // Monday start
  assert.ok(grid.some((c) => c.iso === "2026-06-01" && c.inMonth));
  assert.ok(grid.some((c) => c.iso === "2026-06-30" && c.inMonth));
});

test("civilDate monthGrid produces 42 distinct cells for December 2199 without duplicate clamp keys", () => {
  const grid = monthGrid(2199, 12);
  assert.equal(grid.length, 42);
  const keys = new Set(grid.map((c) => c.iso));
  assert.equal(keys.size, 42);
});

test("civilDate parseUK parses DD/MM/YYYY, D/M/YY, ISO and rejects invalid dates", () => {
  assert.equal(parseUK("15/06/2026"), "2026-06-15");
  assert.equal(parseUK("15/6/26"), "2026-06-15");
  assert.equal(parseUK("15.6.26"), "2026-06-15");
  assert.equal(parseUK("15-6-26"), "2026-06-15");
  assert.equal(parseUK("2026-06-15"), "2026-06-15");
  assert.equal(parseUK("31/02/2026"), null); // invalid day in Feb
  assert.equal(parseUK("15/06-2026"), null); // mismatched separators
  assert.equal(parseUK(""), null);
});

test("civilDate formatLong produces deterministic format without comma variations", () => {
  assert.equal(formatLong("2026-06-15"), "Monday 15 June 2026");
});

test("notesQueue synchronous in-memory read and write", () => {
  assert.equal(notesQueue.get("app-test-1", "initial"), "initial");
  notesQueue.set("app-test-1", "updated text", "initial");
  assert.equal(notesQueue.get("app-test-1"), "updated text");
});

test("notesQueue: opening and closing notes without typing writes nothing", async () => {
  const unsubscribe = notesQueue.subscribe("app-clean-1", () => {});
  unsubscribe();
  await notesQueue.flush("app-clean-1");
  assert.equal(notesQueue.getStatus("app-clean-1"), "idle");
});

test("notesQueue: a clean queue prefers fallback from remote updates", () => {
  notesQueue.set("app-remote-1", "Local draft", "Local draft");
  assert.equal(notesQueue.get("app-remote-1", "Remote text B"), "Remote text B");
});

test("layers: dismissTopLayer returns false when no layer or no onEscape handler", () => {
  assert.equal(dismissTopLayer(), false);
});

test("route parameters reject negative and fractional pages and bad times", () => {
  assert.equal((parseRoute("?v=reader&id=x&page=-3") as { page?: number }).page, undefined);
  assert.equal((parseRoute("?v=reader&id=x&page=1.5") as { page?: number }).page, undefined);
  assert.equal((parseRoute("?v=session&id=s&t=abc") as { t?: number }).t, undefined);
  assert.equal((parseRoute("?v=session&id=s&rec=r1&t=5") as { rec?: string }).rec, "r1");
  assert.deepEqual(parseRoute("?v=essay&id=mod1&q=versailles"), { view: "essay", id: "mod1", q: "versailles" });
});

{
  const name = "video MIME detection and metadata parsing handle mp4, m4v, mov, webm and transcripts";
  try {
    const { mimeFor } = await import("../src/lib/uploads");
    const { isVideoMime, parseVideoMeta } = await import("../src/lib/video");

    assert.equal(mimeFor({ name: "Documentary.mp4", type: "" }), "video/mp4");
    assert.equal(mimeFor({ name: "Lecture.m4v", type: "" }), "video/mp4");
    assert.equal(mimeFor({ name: "Archive_Reel.mov", type: "" }), "video/quicktime");
    assert.equal(mimeFor({ name: "Speech.webm", type: "video/webm" }), "video/webm");
    assert.equal(mimeFor({ name: "Recording.webm", type: "audio/webm" }), "audio/webm");

    assert.equal(isVideoMime("video/mp4"), true);
    assert.equal(isVideoMime("video/quicktime"), true);
    assert.equal(isVideoMime("video/webm"), true);
    assert.equal(isVideoMime("audio/webm"), false);
    assert.equal(isVideoMime("application/pdf"), false);

    const parsed = parseVideoMeta(JSON.stringify({
      duration: 185,
      transcript_name: "speech.txt",
      transcript_text: "00:12 Opening remarks.\n\n01:45 The treaty terms.",
      transcript_updated_at: "2026-11-03T12:00:00.000Z",
    }));
    assert.equal(parsed.duration, 185);
    assert.equal(parsed.transcript_name, "speech.txt");
    assert.ok(parsed.transcript_text?.includes("The treaty terms."));

    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n${(error as Error).message}`);
  }
}

{
  const name = "docx writer and reader round-trip native Word footnotes, review comments, formatting and word counts";
  try {
    const {
      toDocxBytes,
      fromDocxBytes,
      extractDocxText,
      readZipEntries,
      countDocxWords,
      computeFootnoteNumbers,
    } = await import("../src/lib/docx");
    const { formatChicagoFootnote } = await import("../src/lib/assessment");

    const sampleDoc = {
      blocks: [
        {
          id: "b1",
          type: "heading1" as const,
          runs: [{ type: "text" as const, text: "Origins of the July Crisis" }],
        },
        {
          id: "b2",
          type: "paragraph" as const,
          runs: [
            { type: "text" as const, text: "Austria-Hungary issued the ultimatum " },
            { type: "text" as const, text: "with Berlin's backing\u000B", bold: true, highlight: "yellow", commentIds: ["c1"] },
            { type: "footnote_ref" as const, footnoteId: "fn-first" },
            { type: "text" as const, text: " and mobilised rapidly." },
            { type: "footnote_ref" as const, footnoteId: "fn-second" },
          ],
        },
        {
          id: "b3",
          type: "blockquote" as const,
          runs: [{ type: "text" as const, text: "A leap into the dark." }],
        },
      ],
      footnotes: [
        {
          id: "fn-first",
          text: "Christopher Clark, The Sleepwalkers (London, 2012), p. 412.",
        },
        {
          id: "fn-second",
          text: "Clark, The Sleepwalkers, p. 450.",
        },
      ],
      comments: [
        {
          id: "c1",
          author: "Supervisor",
          date: "2026-11-03T10:00:00.000Z",
          text: "Expand on Hoyos's mission here.",
          resolved: true,
        },
      ],
      settings: {
        font: "Times New Roman" as const,
        fontSizePt: 12,
        lineSpacing: 1.5 as const,
        includeFootnotesInCount: true,
        includeQuotesInCount: true,
      },
    };

    const fnMap = computeFootnoteNumbers(sampleDoc);
    assert.equal(fnMap.get("fn-first"), 1);
    assert.equal(fnMap.get("fn-second"), 2);

    const bytes = toDocxBytes(sampleDoc, { title: "July Crisis Essay" });
    const entries = await readZipEntries(bytes);
    const dec = new TextDecoder();

    assert.ok(entries.has("[Content_Types].xml"));
    assert.ok(entries.has("word/document.xml"));
    assert.ok(entries.has("word/footnotes.xml"));
    assert.ok(entries.has("word/comments.xml"));
    assert.ok(entries.has("word/commentsExtended.xml"));

    const footnotesXml = dec.decode(entries.get("word/footnotes.xml")!);
    assert.ok(footnotesXml.includes('w:type="separator" w:id="-1"'), "has separator footnote -1");
    assert.ok(footnotesXml.includes('w:type="continuationSeparator" w:id="0"'), "has continuationSeparator 0");
    assert.ok(footnotesXml.includes("<w:footnoteRef/>"), "includes w:footnoteRef marker");
    assert.ok(footnotesXml.includes('w:id="1"'), "sequential footnote id 1");
    assert.ok(footnotesXml.includes('w:id="2"'), "sequential footnote id 2");

    const docXml = dec.decode(entries.get("word/document.xml")!);
    assert.ok(!docXml.includes("\u000B"), "illegal XML 1.0 control char stripped");
    assert.ok(docXml.includes('xml:space="preserve"'), "preserves leading/trailing whitespace on w:t");

    const roundTripped = await fromDocxBytes(bytes);
    assert.equal(roundTripped.blocks.length, 3);
    assert.equal(roundTripped.blocks[0].type, "heading1");
    assert.equal(roundTripped.footnotes.length, 2);
    assert.ok(roundTripped.footnotes[0].text.includes("The Sleepwalkers"));
    assert.equal(roundTripped.comments.length, 1);
    assert.equal(roundTripped.comments[0].resolved, true);
    assert.equal(roundTripped.comments[0].text, "Expand on Hoyos's mission here.");

    const cleanBytes = toDocxBytes(sampleDoc, { excludeResolvedComments: true });
    const cleanRoundTrip = await fromDocxBytes(cleanBytes);
    assert.equal(cleanRoundTrip.comments.length, 0);

    const plain = await extractDocxText(bytes);
    assert.ok(plain.includes("Origins of the July Crisis"));
    assert.ok(plain.includes("A leap into the dark."));

    const countsAll = countDocxWords(sampleDoc);
    const countsBodyOnly = countDocxWords({
      ...sampleDoc,
      settings: { ...sampleDoc.settings, includeFootnotesInCount: false, includeQuotesInCount: false },
    });
    assert.ok(countsAll.total > countsBodyOnly.total);
    assert.equal(countsBodyOnly.total, countsAll.body);

    const fakeItem = {
      id: "i1",
      title: "The Sleepwalkers",
      author: "Clark, Christopher",
      year: 2012,
      kind: "secondary" as const,
      publisher: "Allen Lane",
      place: "London",
    } as never;
    const fullFn = formatChicagoFootnote(fakeItem, "p. 412", false);
    const shortFn = formatChicagoFootnote(fakeItem, "p. 450", true);
    assert.ok(fullFn.startsWith("Christopher Clark, The Sleepwalkers"), `Expected Chicago note order, got: ${fullFn}`);
    assert.ok(fullFn.includes("412."));
    assert.equal(shortFn, "Clark, The Sleepwalkers, p. 450.");

    // Verify self-closing <w:del/>, <w:p/> and <w:numId w:val="0"/> in fromDocxBytes
    const enc = new TextEncoder();
    const customXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p/>
    <w:p>
      <w:pPr>
        <w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>
        <w:rPr><w:del w:id="1" w:author="Ed"/></w:rPr>
      </w:pPr>
      <w:r><w:t>Live text survives</w:t></w:r>
      <w:del w:id="2" w:author="Ed"><w:r><w:delText>Deleted text</w:delText></w:r></w:del>
    </w:p>
  </w:body>
</w:document>`;
    const customZip = createZip([{ name: "word/document.xml", data: enc.encode(customXml) }]);
    const parsedCustom = await fromDocxBytes(customZip);
    assert.equal(parsedCustom.blocks.length, 2, "empty <w:p/> and following <w:p> are separate blocks");
    assert.equal(parsedCustom.blocks[1].type, "paragraph", "numId=0 stays paragraph");
    assert.equal(parsedCustom.blocks[1].runs[0].text, "Live text survives", "self-closing w:del does not eat live runs");

    // Verify offset-aware run splicing, mid-paragraph footnote insertion, splitting and range formatting
    const {
      spliceRunsOnTextEdit,
      insertRunAtOffset,
      splitBlockRunsAtOffset,
      formatRunsInRange,
    } = await import("../src/lib/docx");

    const initialRuns = [
      { type: "text" as const, text: "Hello " },
      { type: "text" as const, text: "brave", bold: true, commentIds: ["c-1"] },
      { type: "footnote_ref" as const, footnoteId: "fn-1" },
      { type: "text" as const, text: " world." },
    ];
    const editedRuns = spliceRunsOnTextEdit(initialRuns, "Hello very brave new world.");
    assert.equal(
      editedRuns.filter((r) => r.type === "text").map((r) => r.text).join(""),
      "Hello very brave new world.",
    );
    assert.ok(editedRuns.some((r) => r.type === "footnote_ref" && r.footnoteId === "fn-1"), "footnote_ref preserved");
    assert.ok(editedRuns.some((r) => r.type === "text" && r.bold && r.commentIds?.includes("c-1")), "bold + comment preserved");

    const withMidFn = insertRunAtOffset(
      [{ type: "text" as const, text: "First clause, second clause." }],
      13,
      { type: "footnote_ref", footnoteId: "fn-mid" },
    );
    assert.equal(withMidFn.length, 3);
    assert.equal(withMidFn[0].text, "First clause,");
    assert.equal(withMidFn[1].type, "footnote_ref");
    assert.equal(withMidFn[2].text, " second clause.");

    const split = splitBlockRunsAtOffset(withMidFn, 13);
    assert.ok(split.before.some((r) => r.type === "footnote_ref" && r.footnoteId === "fn-mid"));
    assert.equal(split.after[0].text, " second clause.");

    const formattedRange = formatRunsInRange(
      [{ type: "text" as const, text: "The quick brown fox" }],
      4,
      9,
      (r) => ({ ...r, italic: true }),
    );
    assert.equal(formattedRange.length, 3);
    assert.equal(formattedRange[0].text, "The ");
    assert.equal(formattedRange[0].italic, undefined);
    assert.equal(formattedRange[1].text, "quick");
    assert.equal(formattedRange[1].italic, true);
    assert.equal(formattedRange[2].text, " brown fox");

    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n${(error as Error).message}`);
  }
}

test("an old link to the import page opens its module", () => {
  assert.deepEqual(parseRoute("?v=import&id=m1"), { view: "module", id: "m1" });
  assert.deepEqual(parseRoute("?v=import"), { view: "home" });
});

test("the module page offers no Import readings button", () => {
  const source = readFileSync(new URL("../src/components/ModulePage.tsx", import.meta.url), "utf8");
  assert.ok(!source.includes("Import readings"), "ModulePage still mentions Import readings");
  assert.ok(!source.includes('view: "import"'), "ModulePage still links to the import page");
});

test("the date card says what the date is now", () => {
  assert.equal(chosenDateText("2026-10-12"), "Now: Monday 12 October 2026");
  assert.equal(chosenDateText(null), "No date chosen yet");
  assert.equal(chosenDateText("not a date"), "No date chosen yet");
});

test("the date card has no quick chips and a Clear date button apart from Cancel", () => {
  const source = readFileSync(new URL("../src/components/DatePicker.tsx", import.meta.url), "utf8");
  for (const gone of ["Next Monday", "Tomorrow", "date-picker-chips", "quickChips"]) {
    assert.ok(!source.includes(gone), `DatePicker still has ${gone}`);
  }
  assert.ok(source.includes("Clear date") && source.includes("date-picker-foot"), "Clear date belongs in the card's foot");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.ok(!css.includes(".date-chip"), "the quick chips' styles remain");
  assert.ok(css.includes(".date-picker-dialog.is-card"), "the centred card has no styles");
});

test("one top bar serves both sides, with the switch between them", () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/<header className=/g) ?? []).length, 1, "there should be one top bar");
  assert.equal((source.match(/<TopBar route=\{route\} \/>/g) ?? []).length, 2, "both sides should use TopBar");
  assert.ok(!source.includes("Back to Study Library"), "the old way back from the job search remains");
});

test("a folder's view opens as File Explorer's would", () => {
  const pdf = { file: { mime: "application/pdf" }, upload: null } as never;
  const video = { file: { mime: "video/mp4" }, upload: null } as never;
  assert.equal(defaultViewMode({ library: false, views: [pdf, pdf] }), "compact");
  assert.equal(defaultViewMode({ library: true, views: [pdf] }), "icons");
  assert.equal(defaultViewMode({ library: false, views: [video, video] }), "large");
  assert.equal(defaultViewMode({ library: true, views: [video] }), "large");
  assert.equal(defaultViewMode({ library: false, views: [video, pdf] }), "compact");
  assert.equal(defaultViewMode({ library: false, views: [] }), "compact");
});

test("view choices are checked and kept for each folder", () => {
  assert.deepEqual(VIEW_MODES.map((m) => m.label), ["Compact", "Normal", "Icons", "Large icons"]);
  assert.equal(parseViewMode("icons"), "icons");
  assert.equal(parseViewMode("details"), null);
  assert.equal(parseViewMode(null), null);
  assert.equal(viewSettingKey("w1"), "view:w1");
  assert.ok(isTileMode("icons") && isTileMode("large") && !isTileMode("normal") && !isTileMode("compact"));
});

test("videos and slides have wide pictures, readings have pages", () => {
  const item = (kind: string) => ({ kind }) as never;
  assert.equal(coverShape({ item: item("secondary"), file: { mime: "video/webm" }, upload: null } as never), "wide");
  assert.equal(coverShape({ item: item("slides"), file: { mime: "application/pdf" }, upload: null } as never), "wide");
  assert.equal(coverShape({ item: item("primary"), file: { mime: "application/pdf" }, upload: null } as never), "page");
});

test("a video's frame is taken a tenth of the way in, within the first minute", () => {
  assert.equal(videoFrameTime(100), 10);
  assert.equal(videoFrameTime(3600), 60);
  assert.equal(videoFrameTime(4), 1);
  assert.equal(videoFrameTime(1), 0.5);
  assert.equal(videoFrameTime(Number.NaN), 1);
  assert.equal(videoFrameTime(null), 1);
});

test("shelves keep their own shape, with their pictures shown whole", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.ok(/\.week-card\.is-shelf \.week-card-cover,\s*\.week-card\.is-library \.week-card-cover \{\s*aspect-ratio: 2 \/ 3;/.test(css), "a shelf card lost its own shape");
  assert.ok(/\.week-card-cover \.shelf-covers img \{[^}]*object-fit: contain/.test(css), "a shelf's cover is cut to the card");
  assert.ok(/\.week-card\.is-shelf \.week-card-cover > img \{[^}]*object-fit: contain/.test(css), "a shelf's own picture is cut to the card");
});

test("a large reading not on this device opens a piece at a time", () => {
  assert.equal(shouldStream(STREAM_FROM_BYTES, false, true), true);
  assert.equal(shouldStream(STREAM_FROM_BYTES - 1, false, true), false);
  assert.equal(shouldStream(STREAM_FROM_BYTES * 4, true, true), false);
  assert.equal(shouldStream(STREAM_FROM_BYTES * 4, false, false), false);
  assert.equal(shouldStream(null, false, true), false);
});

test("a long book starts with every page the size of its first", () => {
  const sizes = estimatedSizes({ width: 432, height: 648 }, 3);
  assert.deepEqual(sizes, [{ width: 432, height: 648 }, { width: 432, height: 648 }, { width: 432, height: 648 }]);
  sizes[0].width = 1;
  assert.equal(sizes[1].width, 432, "each page has a size of its own");
  assert.ok(sameSize({ width: 432, height: 648 }, { width: 432.2, height: 647.9 }));
  assert.ok(!sameSize({ width: 432, height: 648 }, { width: 648, height: 432 }));
});

test("details found from an ISBN say so", () => {
  assert.match(viaLabel("isbn"), /ISBN/);
  assert.match(viaLabel("isbn-chapter"), /book it comes from/);
});

test("a folded collapsible heading hides its whole section", () => {
  const blocks = [
    { id: "h1", type: "heading", level: 2, toggleable: true, open: false },
    { id: "p1", type: "paragraph" },
    { id: "h2", type: "heading", level: 3 },
    { id: "p2", type: "bulletListItem" },
    { id: "h3", type: "heading", level: 2 },
    { id: "p3", type: "paragraph" },
  ];
  assert.deepEqual(foldedBlockIds(blocks), ["p1", "h2", "p2"]);
  assert.deepEqual(foldedBlockIds(blocks.map((b) => (b.id === "h1" ? { ...b, open: true } : b))), []);
  // A heading that is not collapsible never folds, and a higher one ends a fold.
  assert.deepEqual(foldedBlockIds([{ id: "a", type: "heading", level: 2, open: false }, { id: "b", type: "paragraph" }]), []);
  assert.deepEqual(foldedBlockIds([
    { id: "a", type: "heading", level: 3, toggleable: true, open: false },
    { id: "b", type: "paragraph" },
    { id: "c", type: "heading", level: 1 },
    { id: "d", type: "paragraph" },
  ]), ["b"]);
  assert.equal(foldStyles("s1", []), "");
  assert.equal(foldStyles("s1", ["b"]), '[data-fold-scope="s1"] .bn-block-outer[data-id="b"] { display: none; }');
});

test("collapsible headings are offered in the notes' block menu", () => {
  const source = readFileSync(new URL("../src/components/NoteEditor.tsx", import.meta.url), "utf8");
  for (const key of ["toggle_heading", "toggle_heading_2", "toggle_heading_3"]) assert.ok(source.includes(`"${key}"`), key);
  assert.ok(source.includes("Collapsible heading 1"));
});

test("the assessment page has a route of its own", () => {
  assert.deepEqual(parseRoute("?v=assessment&id=m1"), { view: "assessment", id: "m1" });
  assert.deepEqual(parseRoute("?v=assessment"), { view: "home" });
});

test("the draft's opening and the word count read as a student expects", () => {
  const doc = {
    blocks: [
      { id: "1", type: "heading1" as const, runs: [{ type: "text" as const, text: "Introduction" }] },
      { id: "2", type: "paragraph" as const, runs: [{ type: "text" as const, text: "Austria-Hungary delivered the ultimatum." }, { type: "footnote_ref" as const, footnoteId: "f" }] },
      { id: "3", type: "paragraph" as const, runs: [{ type: "text" as const, text: "Serbia replied within two days." }] },
    ],
    footnotes: [], comments: [],
  };
  assert.equal(draftExcerpt(doc), "Austria-Hungary delivered the ultimatum. Serbia replied within two days.");
  assert.equal(draftExcerpt(doc, 30), "Austria-Hungary delivered the\u2026");
  assert.deepEqual(wordProgress(1250, 2500), { share: 0.5, words: "1,250 of 2,500 words" });
  assert.deepEqual(wordProgress(1, null), { share: 0, words: "1 word" });
  assert.equal(wordProgress(3000, 2500).share, 1);
});

test("Assessment & essay sits under Course materials & assessments", () => {
  const source = readFileSync(new URL("../src/components/ModulePage.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("Course materials & assessments"));
  assert.ok(source.includes("<AssessmentCard module={module} />"));
  assert.ok(!source.includes("AssessmentSection"), "the old inline section remains");
});

test("the application card's notes button keeps one name", () => {
  const source = readFileSync(new URL("../src/components/jobs/AppSheet.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("Open notes") && !source.includes("Add notes"));
});

test("the essay question is labelled once, and its card title is a touch target", () => {
  const page = readFileSync(new URL("../src/components/AssessmentPage.tsx", import.meta.url), "utf8");
  assert.equal((page.match(/Essay question/g) ?? []).length, 1, "only the question's own label says Essay question");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.ok(/\.essay-card-title \{[^}]*min-height: 2\.75rem/.test(css), "the card title is too small to tap");
});

test("textnorm repairs ligatures and Calibri glyphs in context", () => {
  assert.equal(repairText("ﬁnal ﬂow oﬀer eﬃcient baﬄe ﬅop ﬆop ſun"), "final flow offer efficient baffle stop stop sun");
  assert.equal(repairText("informaƟon leŌ aŌer"), "information left after");
  assert.equal(repairText("café résumé"), "café résumé");
  assert.equal(repairText("Ōsaka"), "Ōsaka");
  assert.equal(searchFold("Café ﬁnal Straße"), "cafe final strasse");
  assert.equal(searchFold("informaƟon"), "information");
});

test("assessmentEnabled distinguishes empty defaults from user work", () => {
  assert.equal(isAssessmentEnabled({ enabled: true }), true);
  assert.equal(isAssessmentEnabled({ enabled: false, title: "Custom" }), false);
  assert.equal(isAssessmentEnabled({ title: "Assessment", wordTarget: 2000, draft: { text: "" } }), false);
  assert.equal(isAssessmentEnabled({ title: "Custom Topic", wordTarget: 2000 }), true);
  assert.equal(isAssessmentEnabled({ wordCount: 150 }), true);
});

test("jobsCard describes deadlines and urgency", () => {
  const now = new Date(2026, 10, 9, 12, 0);
  assert.equal(describeDeadline(new Date(2026, 10, 9, 8), now)?.urgency, "today");
  assert.equal(describeDeadline(new Date(2026, 10, 10), now)?.urgency, "soon");
  assert.equal(describeDeadline(new Date(2026, 10, 5), now)?.urgency, "overdue");
});

test("wordcraftChrome parses reports and validates embedded insets", () => {
  const c = parseChrome({
    embedded: true,
    tabStrip: { top: 0, height: 30, insetStart: 100, insetEnd: 116 },
    statusBar: { height: 26, insetStart: 310 },
    colours: { tabStrip: "#1f1f1f", text: "red", accent: "#7A93F0" },
  });
  assert.deepEqual(c?.tabStrip, { top: 0, height: 30, insetStart: 100, insetEnd: 116 });
  assert.deepEqual(c?.colours, { tabStrip: "#1f1f1f", accent: "#7A93F0" });

  assert.equal(parseChrome(null), null);
  assert.equal(parseChrome({ embedded: false }), null);
  assert.equal(parseChrome("embedded"), null);

  const fallbackGeometry = parseChrome({ embedded: true, tabStrip: { height: "tall" } });
  assert.equal(fallbackGeometry?.tabStrip.height, 30);
  assert.equal(fallbackGeometry?.statusBar.height, 26);

  assert.ok(INSETS_COMPACT.tabStart + INSETS_COMPACT.tabEnd < INSETS_REGULAR.tabStart + INSETS_REGULAR.tabEnd);

  const fallback = dockGeometry(null);
  assert.deepEqual(fallback.back, { top: 0, width: FILE_TAB_COVER.width, height: FILE_TAB_COVER.height, iconOnly: false });
  assert.deepEqual(fallback.status, { height: FALLBACK_STATUS_HEIGHT, span: "full" });

  const query = editorQuery(INSETS_REGULAR);
  assert.ok(query.includes(`fileGuard=${FILE_TAB_COVER.width},${FILE_TAB_COVER.height}`));
  assert.ok(query.includes(`tabInset=${INSETS_REGULAR.tabStart},${INSETS_REGULAR.tabEnd}`));
});

registerNotesAndReadingsTests(test);
registerListenTests(test);

if (failed) {

  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall web tests passed");
