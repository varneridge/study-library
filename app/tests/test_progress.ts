import assert from "node:assert/strict";
import { counts, citable, readCount, moduleProgress, progressWords } from "../src/lib/progress";
import { KIND_ORDER, KIND_LABEL, KIND_GROUP, KIND_GROUP_ORDER, KIND_DELETE_LABEL, deleteLabel, KIND_NOUN, KIND_TOAST_DELETED } from "../src/lib/kinds";
import type { ItemRow, WeekRow } from "../src/lib/types";
import type { TeachingWeek, TermDates } from "../src/lib/term";

export function registerProgressTests(test: (name: string, fn: () => void) => void) {
  test("kinds.ts defines labels and orders without duplicates", () => {
    assert.deepEqual(KIND_ORDER, ["primary", "secondary", "summary", "slides"]);
    assert.deepEqual(KIND_GROUP_ORDER, ["primary", "secondary", "summary"]);

    const labels = Object.values(KIND_LABEL);
    assert.equal(new Set(labels).size, labels.length, "Labels must be unique");

    const groups = Object.values(KIND_GROUP);
    assert.equal(new Set(groups).size, groups.length, "Groups must be unique");

    assert.equal(deleteLabel("summary"), "Delete summary");
    assert.equal(deleteLabel("slides"), "Delete slides");
    assert.equal(deleteLabel("primary"), "Delete reading");
    assert.equal(deleteLabel("secondary"), "Delete reading");

    assert.equal(KIND_NOUN.summary, "summary");
    assert.equal(KIND_NOUN.slides, "slides");
    assert.equal(KIND_TOAST_DELETED.summary, "Summary deleted.");
  });

  test("counts and citable are true for primary and secondary only", () => {
    const primary = { kind: "primary" as const, title: "P" };
    const secondary = { kind: "secondary" as const, title: "S" };
    const summary = { kind: "summary" as const, title: "Sum" };
    const slides = { kind: "slides" as const, title: "Deck" };
    const deletedPrimary = { kind: "primary" as const, title: "P", deleted: 1 };

    assert.equal(counts(primary), true);
    assert.equal(counts(secondary), true);
    assert.equal(counts(summary), false);
    assert.equal(counts(slides), false);
    assert.equal(counts(deletedPrimary), false);

    assert.equal(citable(primary), true);
    assert.equal(citable(secondary), true);
    assert.equal(citable(summary), false);
    assert.equal(citable(slides), false);
    assert.equal(citable(deletedPrimary), false);
  });

  test("readCount counts primary and secondary, ignoring slides, summaries, and deleted items", () => {
    const makeItem = (id: string, kind: ItemRow["kind"], read: boolean, deleted = false): ItemRow =>
      ({
        id,
        kind,
        title: `Item ${id}`,
        read_status: read ? "read" : "unread",
        deleted,
        modified_at: "",
        author: null,
        source: null,
        pages: null,
        year: null,
        doc_date: null,
        file_id: null,
        original_file_id: null,
        tray_module_id: null,
        zotero_key: null,
        last_page: null,
      });

    const items: ItemRow[] = [
      makeItem("1", "primary", true),
      makeItem("2", "secondary", false),
      makeItem("3", "summary", true),
      makeItem("4", "slides", true),
      makeItem("5", "secondary", true, true),
    ];

    const result = readCount(items);
    assert.equal(result.read, 1);
    assert.equal(result.total, 2);
  });

  test("moduleProgress and progressWords cover every row of the 3A.3 specification", () => {
    const dates: TermDates = { AT: "2026-09-28", WT: "2027-01-11" };

    const makeWeek = (term: "AT" | "WT" | "S", number: number, is_reading_week = false): WeekRow => ({
      id: `w_${term}_${number}`,
      module_id: "m1",
      term,
      number,
      title: `Week ${number}`,
      is_reading_week,
      deleted: false,
      modified_at: "",
    });

    const makeItem = (id: string, kind: ItemRow["kind"], read: boolean): ItemRow =>
      ({
        id,
        kind,
        title: `Item ${id}`,
        read_status: read ? "read" : "unread",
        deleted: false,
        modified_at: "",
        author: null,
        source: null,
        pages: null,
        year: null,
        doc_date: null,
        file_id: null,
        original_file_id: null,
        tray_module_id: null,
        zotero_key: null,
        last_page: null,
      });

    const at4Week = makeWeek("AT", 4);
    const at4Items: ItemRow[] = [
      makeItem("1", "primary", true),
      makeItem("2", "secondary", false),
      makeItem("3", "secondary", false),
      makeItem("4", "summary", false),
      makeItem("5", "slides", true),
    ];

    const at6Week = makeWeek("AT", 6, true);
    const at6Items: ItemRow[] = [];

    const at6WithItemsWeek = makeWeek("AT", 6, true);
    const at6Readings: ItemRow[] = [
      makeItem("6", "primary", true),
      makeItem("7", "secondary", false),
    ];

    const at1Week = makeWeek("AT", 1);
    const at1Items: ItemRow[] = [
      makeItem("8", "primary", false),
      makeItem("9", "secondary", false),
      makeItem("10", "secondary", false),
      makeItem("11", "secondary", false),
    ];

    const wt1Week = makeWeek("WT", 1);
    const wt1Items: ItemRow[] = [
      makeItem("12", "primary", true),
      makeItem("13", "secondary", false),
      makeItem("14", "secondary", false),
    ];

    const allWeeks = [
      { week: at1Week, items: at1Items },
      { week: at4Week, items: at4Items },
      { week: at6Week, items: at6Items },
      { week: wt1Week, items: wt1Items },
    ];

    // 1. Term, a teaching week (AT4: 1 of 3 read)
    const nowAT4: TeachingWeek = { term: "AT", number: 4, upcoming: false };
    const p1 = moduleProgress(allWeeks, nowAT4);
    assert.equal(p1.state, "week");
    if (p1.state === "week") {
      assert.equal(p1.read, 1);
      assert.equal(p1.total, 3);
      assert.equal(progressWords(p1, dates), "AT4: 1 of 3 read");
    }

    // 1b. AT4: none read -> "AT4: 3 readings"
    const p1b = moduleProgress([
      { week: at4Week, items: [makeItem("1", "primary", false), makeItem("2", "secondary", false), makeItem("3", "secondary", false)] },
    ], nowAT4);
    assert.equal(progressWords(p1b, dates), "AT4: 3 readings");

    // 1c. AT4: all read -> "AT4: all 3 read"
    const p1c = moduleProgress([
      { week: at4Week, items: [makeItem("1", "primary", true), makeItem("2", "secondary", true), makeItem("3", "secondary", true)] },
    ], nowAT4);
    assert.equal(progressWords(p1c, dates), "AT4: all 3 read");

    // 2. Reading week with no readings -> "AT6: reading week"
    const nowAT6: TeachingWeek = { term: "AT", number: 6, upcoming: false };
    const p2 = moduleProgress(allWeeks, nowAT6);
    assert.equal(p2.state, "reading-week");
    assert.equal(progressWords(p2, dates), "AT6: reading week");

    // 2b. Reading week with readings -> "AT6: reading week (1 of 2 read)"
    const p2b = moduleProgress([{ week: at6WithItemsWeek, items: at6Readings }], nowAT6);
    assert.equal(progressWords(p2b, dates), "AT6: reading week (1 of 2 read)");

    // 3. Term, but module has no such week (e.g. dissertation or missing week) -> state "none"
    const dissertationWeeks = [
      { week: makeWeek("S", 1), items: [] },
      { week: makeWeek("S", 2), items: [] },
    ];
    const p3 = moduleProgress(dissertationWeeks, nowAT4);
    assert.equal(p3.state, "none");
    assert.equal(progressWords(p3, dates), "");

    // 4. Up to five weeks before AT1 -> "AT1 starts 28 Sep: 0 of 4 read"
    const upcomingAT1: TeachingWeek = { term: "AT", number: 1, upcoming: true };
    const p4 = moduleProgress(allWeeks, upcomingAT1);
    assert.equal(p4.state, "upcoming");
    assert.equal(progressWords(p4, dates), "AT1 starts 28 Sep: 0 of 4 read");

    // 5. Christmas vacation (upcoming WT1) -> "WT1 starts 11 Jan: 1 of 3 read"
    const upcomingWT1: TeachingWeek = { term: "WT", number: 1, upcoming: true };
    const p5 = moduleProgress(allWeeks, upcomingWT1);
    assert.equal(p5.state, "upcoming");
    assert.equal(progressWords(p5, dates), "WT1 starts 11 Jan: 1 of 3 read");

    // 6. After WT11 (now is null) -> state "none"
    const p6 = moduleProgress(allWeeks, null);
    assert.equal(p6.state, "none");
    assert.equal(progressWords(p6, dates), "");

    // 7. Week with no readings -> "AT4: no readings"
    const p7 = moduleProgress([{ week: at4Week, items: [] }], nowAT4);
    assert.equal(p7.state, "week");
    assert.equal(progressWords(p7, dates), "AT4: no readings");
  });
}
