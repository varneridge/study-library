// Tests for the essay's sources: how a footnote keeps its source through a save from
// Word, how stored links and per-essay facts are read back, how a source moves between
// the groups and the admin documents, the order sources are listed in, and what a
// dropped file's name says about it. Registered from run.ts.

import assert from "node:assert/strict";
import {
  carryFootnoteBindings,
  compareSourceTitles,
  normaliseSourceLink,
  normaliseSourceMeta,
  type SourceLink,
} from "../src/lib/essaySources";
import { defaultAssessmentData, moveSourceTo, normaliseAssessmentData, readingCategoryOf, type AssessmentData } from "../src/lib/assessment";
import type { DocxDocument, DocxFootnote } from "../src/lib/docx";
import { draftFromFile } from "../src/lib/sourceIntake";

export function registerEssaySourcesTests(test: (name: string, fn: () => void) => void): void {
  const NOW = "2026-11-23T12:00:00.000Z";
  const draft = (footnotes: DocxFootnote[]): DocxDocument => ({ blocks: [], footnotes, comments: [] });

  // carryFootnoteBindings

  test("a footnote keeps its source when Word gives it a new id", () => {
    const prev = draft([
      { id: "fn-abc", text: "Hobsbawm, The Age of Revolution, 12.", citationItemId: "r1", locator: "p. 12" },
      { id: "fn-def", text: "Thompson, The Making of the English Working Class, 45.", citationItemId: "r2" },
    ]);
    // Word renumbers the notes and, here, swaps their order and loosens a space.
    const next = draft([
      { id: "fn-1", text: "Thompson, The Making of the  English Working Class, 45." },
      { id: "fn-2", text: "Hobsbawm, The Age of Revolution, 12." },
    ]);
    const links: SourceLink[] = [{ id: "l1", sourceId: "r1", footnoteId: "fn-abc", highlightId: "h1", page: "12" }];
    const out = carryFootnoteBindings(prev, next, links, { now: NOW });
    assert.deepEqual(out.draft.footnotes, [
      { id: "fn-1", text: "Thompson, The Making of the  English Working Class, 45.", citationItemId: "r2" },
      { id: "fn-2", text: "Hobsbawm, The Age of Revolution, 12.", citationItemId: "r1", locator: "p. 12" },
    ]);
    assert.deepEqual(out.sourceLinks, [{ id: "l1", sourceId: "r1", footnoteId: "fn-2", highlightId: "h1", page: "12", updated_at: NOW }]);
  });

  test("curly and straight quotation marks count as the same footnote text", () => {
    const prev = draft([{ id: "fn-a", text: "Clark, \u201cThe Sleepwalkers\u201d, 412.", citationItemId: "r1" }]);
    const next = draft([{ id: "fn-1", text: "Clark, \"The Sleepwalkers\", 412." }]);
    assert.equal(carryFootnoteBindings(prev, next, [], { pairByOrder: false }).draft.footnotes[0].citationItemId, "r1");
  });

  test("a reworded note keeps its source when as many notes went as came", () => {
    const prev = draft([{ id: "fn-a", text: "Old wording", citationItemId: "r1" }, { id: "fn-b", text: "Same", citationItemId: "r2" }]);
    const next = draft([{ id: "fn-1", text: "New wording" }, { id: "fn-2", text: "Same" }]);
    const links: SourceLink[] = [{ id: "l1", sourceId: "r1", footnoteId: "fn-a" }];
    const out = carryFootnoteBindings(prev, next, links, { now: NOW });
    assert.deepEqual(out.draft.footnotes.map((n) => n.citationItemId), ["r1", "r2"]);
    assert.equal(out.sourceLinks[0].footnoteId, "fn-1");
  });

  test("notes are not paired in order when the counts differ, or when pairing by order is off", () => {
    const prev = draft([{ id: "fn-a", text: "One", citationItemId: "r1" }, { id: "fn-b", text: "Two", citationItemId: "r2" }]);
    const fewer = carryFootnoteBindings(prev, draft([{ id: "fn-1", text: "Reworded" }]), [], { now: NOW });
    assert.equal(fewer.draft.footnotes[0].citationItemId, undefined);
    const imported = carryFootnoteBindings(
      draft([{ id: "fn-a", text: "Old", citationItemId: "r1" }]),
      draft([{ id: "fn-1", text: "Unrelated" }]),
      [{ id: "l1", sourceId: "r1", footnoteId: "fn-a" }],
      { pairByOrder: false, now: NOW },
    );
    assert.equal(imported.draft.footnotes[0].citationItemId, undefined);
    // The link loses its footnote but keeps its source and passage, as a page reference.
    assert.deepEqual(imported.sourceLinks, [{ id: "l1", sourceId: "r1", updated_at: NOW }]);
  });

  test("each earlier note continues at most one new note with the same text", () => {
    const prev = draft([{ id: "fn-a", text: "Ibid.", citationItemId: "r1" }]);
    const next = draft([{ id: "fn-1", text: "Ibid." }, { id: "fn-2", text: "Ibid." }]);
    const out = carryFootnoteBindings(prev, next, [], { pairByOrder: false });
    assert.deepEqual(out.draft.footnotes.map((n) => n.citationItemId), ["r1", undefined]);
  });

  test("a citation waiting for its footnote is bound to the new note with its text", () => {
    const prev = draft([]);
    const next = draft([{ id: "fn-1", text: "Hobsbawm, The Age of Revolution, 12." }]);
    const links: SourceLink[] = [{ id: "w", sourceId: "r1", highlightId: "h1", footnoteText: "Hobsbawm, The Age of Revolution, 12.", awaitingInsert: "tab-1" }];
    const out = carryFootnoteBindings(prev, next, links, { now: NOW });
    assert.deepEqual(out.draft.footnotes, [{ id: "fn-1", text: "Hobsbawm, The Age of Revolution, 12.", citationItemId: "r1" }]);
    assert.deepEqual(out.sourceLinks, [{ id: "w", sourceId: "r1", highlightId: "h1", footnoteText: "Hobsbawm, The Age of Revolution, 12.", footnoteId: "fn-1", updated_at: NOW }]);
  });

  test("a waiting citation claims its new note before notes are paired in order", () => {
    // One note deleted and one inserted in the same save: the inserted note is the
    // waiting citation's, so the deleted note's source must not be carried onto it.
    const prev = draft([{ id: "fn-a", text: "A note that was deleted", citationItemId: "r9" }]);
    const next = draft([{ id: "fn-1", text: "The inserted note" }]);
    const links: SourceLink[] = [
      { id: "old", sourceId: "r9", footnoteId: "fn-a" },
      { id: "new", sourceId: "r1", footnoteText: "The inserted note", awaitingInsert: "tab-1" },
    ];
    const out = carryFootnoteBindings(prev, next, links, { now: NOW });
    assert.equal(out.draft.footnotes[0].citationItemId, "r1");
    assert.equal(out.sourceLinks.find((l) => l.id === "new")?.footnoteId, "fn-1");
    assert.equal(out.sourceLinks.find((l) => l.id === "old")?.footnoteId, undefined);
  });

  test("a waiting citation whose note has not arrived yet keeps waiting", () => {
    const links: SourceLink[] = [{ id: "w", sourceId: "r1", footnoteText: "Not inserted yet.", awaitingInsert: "tab-1" }];
    const out = carryFootnoteBindings(draft([]), draft([{ id: "fn-1", text: "Something else." }]), links, { now: NOW });
    assert.equal(out.sourceLinks, links);
    assert.equal(out.draft.footnotes[0].citationItemId, undefined);
  });

  test("the same draft and the same list come back when nothing needed to change", () => {
    const prev = draft([{ id: "fn-1", text: "A", citationItemId: "r1" }]);
    const next = draft([{ id: "fn-1", text: "A", citationItemId: "r1" }]);
    const links: SourceLink[] = [{ id: "l", sourceId: "r1", footnoteId: "fn-1" }];
    const out = carryFootnoteBindings(prev, next, links);
    assert.equal(out.draft, next);
    assert.equal(out.sourceLinks, links);
    const empty = carryFootnoteBindings(draft([]), draft([]), []);
    assert.equal(empty.sourceLinks.length, 0);
  });

  test("a note that already names its source is not given another", () => {
    const prev = draft([{ id: "fn-a", text: "A", citationItemId: "r1" }]);
    const next = draft([{ id: "fn-1", text: "A", citationItemId: "r7" }]);
    assert.equal(carryFootnoteBindings(prev, next, []).draft.footnotes[0].citationItemId, "r7");
  });

  // normaliseSourceLink and normaliseSourceMeta

  test("a stored link keeps the tab its footnote is waiting for", () => {
    assert.deepEqual(normaliseSourceLink({ id: "l", sourceId: "s", awaitingInsert: " tab-1 " }), { id: "l", sourceId: "s", awaitingInsert: "tab-1" });
    assert.deepEqual(normaliseSourceLink({ id: "l", sourceId: "s", awaitingInsert: "   " }), { id: "l", sourceId: "s" });
    assert.deepEqual(normaliseSourceLink({ id: "l", sourceId: "s", awaitingInsert: 7 }), { id: "l", sourceId: "s", awaitingInsert: "7" });
    assert.deepEqual(normaliseSourceLink({ id: "l", sourceId: "s", awaitingInsert: { tab: 1 } }), { id: "l", sourceId: "s" });
    assert.equal(normaliseSourceLink({ sourceId: "s", awaitingInsert: "tab-1" }), null);
  });

  test("what an essay knows about its sources keeps only groups and types it knows", () => {
    assert.deepEqual(
      normaliseSourceMeta({
        a: { category: "secondary_outside" },
        b: { category: "secondary" },
        c: { category: "tertiary", primaryType: "speech" },
        d: { category: "primary", primaryType: "photograph" },
        e: { category: "Primary" },
        f: { note: "nothing known" },
        g: null,
        h: "primary",
        "": { category: "primary" },
      }),
      {
        a: { category: "secondary_outside" },
        b: { category: "secondary_course" },
        c: { primaryType: "speech" },
        d: { category: "primary" },
      },
    );
    for (const raw of [null, undefined, "x", 3, [], [{ category: "primary" }]]) assert.deepEqual(normaliseSourceMeta(raw), {}, String(raw));
  });

  test("an essay read back from storage keeps its sources' groups only when it has any", () => {
    const stored = { ...defaultAssessmentData("HY1"), sourceMeta: { r1: { category: "secondary_outside", primaryType: "nonsense" } } };
    assert.deepEqual(normaliseAssessmentData(stored, "HY1").sourceMeta, { r1: { category: "secondary_outside" } });
    assert.equal("sourceMeta" in normaliseAssessmentData(defaultAssessmentData("HY1"), "HY1"), false);
  });

  // moveSourceTo

  const essay = (): AssessmentData =>
    normaliseAssessmentData({
      ...defaultAssessmentData("HY1"),
      referenceItemIds: ["r1", "r2"],
      adminDocuments: [{ id: "a1", name: "Marking criteria", size: 5, mime: "application/pdf" }],
      customSources: [{ id: "c1", title: "Letter to Vienna", kind: "primary" }],
      attachedPapers: [
        { id: "p1", title: "Pamphlet", name: "pamphlet.pdf", kind: "secondary_outside", r2Key: "files/k1", mime: "application/pdf", size: 9 },
        { id: "p2", title: "No file kept", kind: "secondary_outside" },
      ],
      sourceMeta: { r2: { category: "primary", primaryType: "speech" } },
      draft: { blocks: [], footnotes: [{ id: "fn-1", text: "Note.", citationItemId: "r1" }, { id: "fn-2", text: "Note.", citationItemId: "p1" }], comments: [] },
      sourceLinks: [{ id: "l1", sourceId: "r1", footnoteId: "fn-1", highlightId: "h1" }, { id: "l2", sourceId: "p1", footnoteId: "fn-2" }],
    });
  const file = { name: "Reading", size: 7, mime: "application/pdf" };

  test("a reading moves between the three groups", () => {
    const data = essay();
    for (const to of ["primary", "secondary_course", "secondary_outside"] as const) {
      const moved = moveSourceTo(data, { type: "reading", id: "r1" }, to);
      assert.equal(readingCategoryOf(moved, { id: "r1", kind: "secondary" }), to, to);
      assert.deepEqual(moved.referenceItemIds, ["r1", "r2"]);
    }
  });

  test("a reading with a file becomes an admin document, and keeps its primary type", () => {
    const data = essay();
    const moved = moveSourceTo(data, { type: "reading", id: "r2" }, "admin", file);
    assert.deepEqual(moved.referenceItemIds, ["r1"]);
    assert.deepEqual(moved.adminDocuments, [{ id: "a1", name: "Marking criteria", size: 5, mime: "application/pdf" }, { id: "r2", name: "Reading", size: 7, mime: "application/pdf" }]);
    assert.deepEqual(moved.sourceMeta, { r2: { primaryType: "speech" } });
  });

  test("a reading without its file's details cannot become an admin document", () => {
    const data = essay();
    assert.equal(moveSourceTo(data, { type: "reading", id: "r1" }, "admin"), data);
  });

  test("a reading already among the admin documents is not listed twice", () => {
    const data = { ...essay(), adminDocuments: [{ id: "r1", name: "Already here", size: 1, mime: "application/pdf" }] };
    assert.deepEqual(moveSourceTo(data, { type: "reading", id: "r1" }, "admin", file).adminDocuments, [{ id: "r1", name: "Already here", size: 1, mime: "application/pdf" }]);
  });

  test("an admin document moves into a group as one of the essay's readings", () => {
    const moved = moveSourceTo(essay(), { type: "admin", id: "a1" }, "secondary_course");
    assert.deepEqual(moved.adminDocuments, []);
    assert.deepEqual(moved.referenceItemIds, ["r1", "r2", "a1"]);
    assert.equal(readingCategoryOf(moved, { id: "a1", kind: "secondary" }), "secondary_course");
    const already = { ...essay(), referenceItemIds: ["a1"] };
    assert.deepEqual(moveSourceTo(already, { type: "admin", id: "a1" }, "primary").referenceItemIds, ["a1"]);
  });

  test("an admin document moved to the admin documents, or one not there, leaves the essay as it was", () => {
    const data = essay();
    assert.equal(moveSourceTo(data, { type: "admin", id: "a1" }, "admin"), data);
    assert.equal(moveSourceTo(data, { type: "admin", id: "gone" }, "primary"), data);
  });

  test("a source added by hand moves between groups but never to the admin documents", () => {
    const data = essay();
    assert.equal(moveSourceTo(data, { type: "custom", id: "c1" }, "admin"), data);
    assert.equal(moveSourceTo(data, { type: "custom", id: "c1" }, "admin", file), data);
    assert.deepEqual(moveSourceTo(data, { type: "custom", id: "c1" }, "secondary_course").customSources, [{ id: "c1", title: "Letter to Vienna", kind: "secondary_course" }]);
  });

  test("an uploaded paper moves between groups, and becomes an admin document only with its stored file", () => {
    const data = essay();
    assert.equal(moveSourceTo(data, { type: "paper", id: "p1" }, "primary").attachedPapers?.[0].kind, "primary");
    const toAdmin = moveSourceTo(data, { type: "paper", id: "p1" }, "admin");
    assert.deepEqual(toAdmin.attachedPapers?.map((p) => p.id), ["p2"]);
    assert.deepEqual(toAdmin.adminDocuments?.[1], { id: "p1", name: "pamphlet.pdf", size: 9, mime: "application/pdf", r2Key: "files/k1" });
    assert.equal(moveSourceTo(data, { type: "paper", id: "p2" }, "admin"), data);
    assert.equal(moveSourceTo(data, { type: "paper", id: "missing" }, "admin"), data);
  });

  test("an uploaded paper with no name or details becomes an admin document under its title", () => {
    const data = { ...essay(), attachedPapers: [{ id: "p3", title: "Scan", kind: "secondary_outside" as const, r2Key: "files/k3" }] };
    assert.deepEqual(moveSourceTo(data, { type: "paper", id: "p3" }, "admin").adminDocuments?.[1], { id: "p3", name: "Scan", size: 0, mime: "application/octet-stream", r2Key: "files/k3" });
  });

  test("a move never touches the footnotes or the passage links that cite the source", () => {
    const data = essay();
    for (const moved of [
      moveSourceTo(data, { type: "reading", id: "r1" }, "admin", file),
      moveSourceTo(data, { type: "reading", id: "r1" }, "primary"),
      moveSourceTo(data, { type: "paper", id: "p1" }, "admin"),
      moveSourceTo(data, { type: "admin", id: "a1" }, "primary"),
    ]) {
      assert.equal(moved.draft, data.draft);
      assert.equal(moved.sourceLinks, data.sourceLinks);
    }
  });

  // compareSourceTitles

  test("sources sort in en-GB order, ignoring accents, case and opening quotation marks", () => {
    const titles = ["\u201cZola\u2019s Paris\u201d", "10 Kings", "\u2018Bront\u00eb\u2019", "2 Kings", "apples", "(Annotated) Burke", "\u00c9mile", "Edward"];
    assert.deepEqual([...titles].sort(compareSourceTitles), ["2 Kings", "10 Kings", "(Annotated) Burke", "apples", "\u2018Bront\u00eb\u2019", "Edward", "\u00c9mile", "\u201cZola\u2019s Paris\u201d"]);
    assert.equal(compareSourceTitles("Bront\u00eb", "bronte"), 0);
    // An opening quotation mark or bracket is ignored, however many there are.
    assert.equal(compareSourceTitles("\u201cThe Age", "The Age"), 0);
    assert.equal(compareSourceTitles("(\u2018The Age", "The Age"), 0);
    assert.ok(compareSourceTitles("Volume 2", "Volume 10") < 0);
  });

  test("sources that compare the same keep the order they were given in", () => {
    // All four compare the same: an accent, case and an opening quotation mark are ignored.
    const given = ["Bronte", "bront\u00eb", "\u2018Bronte", "BRONTE"];
    for (const title of given) assert.equal(compareSourceTitles(given[0], title), 0, title);
    assert.deepEqual([...given].sort(compareSourceTitles), given);
    assert.deepEqual([...given].reverse().sort(compareSourceTitles), [...given].reverse());
  });

  test("a title sorts the same in quotation marks as out of them", () => {
    const sorted = (list: string[]) => [...list].sort(compareSourceTitles);
    assert.deepEqual(sorted(["Age of Revolution", "Age"]), ["Age", "Age of Revolution"]);
    assert.deepEqual(sorted(["Age of Revolution", "\u2018Age\u2019"]), ["\u2018Age\u2019", "Age of Revolution"]);
    assert.deepEqual(sorted(["Lecture notes", "\u2018Lecture\u2019"]), ["\u2018Lecture\u2019", "Lecture notes"]);
    assert.equal(compareSourceTitles("\u2018Bronte\u2019", "Bronte"), 0);
    assert.equal(compareSourceTitles("\u201cThe Age\u201d", "The Age"), 0);
    assert.equal(compareSourceTitles("Napoleon\u2019s Europe", "Napoleon's Europe"), 0);
  });

  // draftFromFile

  test("a file named in the course's convention gives its author, year, title and pages", () => {
    const d = draftFromFile(new File(["x"], "(AT1) Broers, M. (1996) 'Europe under Napoleon, 1799-1815', pp. 1-24.pdf"), "secondary");
    assert.deepEqual(
      { role: d.role, author: d.author, year: d.year, title: d.title, pages: d.pages, source: d.source, name: d.name },
      { role: "secondary", author: "Broers, M.", year: "1996", title: "Europe under Napoleon, 1799-1815", pages: "1-24", source: "", name: "(AT1) Broers, M. (1996) 'Europe under Napoleon, 1799-1815', pp. 1-24" },
    );
    const withSource = draftFromFile(new File(["x"], "(AT2) Dwyer, P. (2002) 'Napoleon and the Drive for Glory', French History 16, pp. 379-403.pdf"), "secondary");
    assert.deepEqual([withSource.source, withSource.pages], ["French History 16", "379-403"]);
  });

  test("any other file gives only its name, without its extension, for the role it was dropped on", () => {
    const d = draftFromFile(new File(["x"], "Essay brief 2026.docx"), "admin");
    assert.deepEqual(
      { role: d.role, name: d.name, title: d.title, author: d.author, year: d.year, thumb: d.thumb, primaryType: d.primaryType, work_kind: d.work_kind },
      { role: "admin", name: "Essay brief 2026", title: "Essay brief 2026", author: "", year: "", thumb: null, primaryType: "other", work_kind: "article" },
    );
    assert.equal(draftFromFile(new File(["x"], "scan of the leaflet.jpeg"), "primary").title, "scan of the leaflet");
    assert.equal(draftFromFile(new File(["x"], "noextension"), "primary").name, "noextension");
  });

  test("each draft has a key of its own and keeps the file it was made from", () => {
    const f = new File(["x"], "a.pdf");
    const first = draftFromFile(f, "secondary");
    const second = draftFromFile(f, "secondary");
    assert.notEqual(first.key, second.key);
    assert.equal(first.file, f);
  });
}
