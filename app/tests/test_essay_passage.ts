import assert from "node:assert/strict";
import {
  addPassageLink,
  createSourceLink,
  linksForFootnote,
  normaliseSourceLinks,
  passageHighlightIds,
  referenceCount,
  referenceLocator,
  removeLinksForFootnote,
  removePassageLink,
  type SourceLink,
} from "../src/lib/essaySources";
import {
  essayKeyParts,
  inReadingOrder,
  referencedInLabel,
  referencesByHighlight,
  type EssaySettingRow,
} from "../src/lib/highlightReferences";
import { href, parseRoute, routeOf } from "../src/lib/router";

const NOW = "2026-11-24T12:00:00.000Z";
const link = (over: Partial<SourceLink> & Pick<SourceLink, "id">): SourceLink =>
  createSourceLink({ sourceId: "item-1", ...over }, NOW);

export function registerEssayPassageTests(test: (name: string, fn: () => void) => void): void {
  test("addPassageLink adds a second highlight and keeps the first", () => {
    const first = link({ id: "l1", footnoteId: "fn1", highlightId: "h1", page: "12" });
    const next = addPassageLink([first], { id: "l2", footnoteId: "fn1", sourceId: "item-1", highlightId: "h2", page: "15" }, NOW);
    assert.deepEqual(passageHighlightIds(next, "fn1"), ["h1", "h2"]);
    assert.equal(next[0], first);
  });

  test("addPassageLink returns the same list when the highlight is already in the reference", () => {
    const links = [link({ id: "l1", footnoteId: "fn1", highlightId: "h1" })];
    assert.equal(addPassageLink(links, { id: "l2", footnoteId: "fn1", sourceId: "item-1", highlightId: "h1" }, NOW), links);
  });

  test("addPassageLink replaces a whole-document link, keeping its label", () => {
    const whole = link({ id: "l0", footnoteId: "fn1", wholeDocument: true, label: "Smith on memory" });
    const other = link({ id: "lx", footnoteId: "fn2", highlightId: "h9" });
    const next = addPassageLink([whole, other], { id: "l1", footnoteId: "fn1", sourceId: "item-1", highlightId: "h1" }, NOW);
    assert.deepEqual(linksForFootnote(next, "fn1").map((l) => l.id), ["l1"]);
    assert.equal(next.find((l) => l.id === "l1")?.label, "Smith on memory");
    assert.ok(next.includes(other));
  });

  test("addPassageLink replaces highlight links to a different source on the same footnote", () => {
    const stray = link({ id: "l0", sourceId: "item-2", footnoteId: "fn1", highlightId: "h0" });
    const next = addPassageLink([stray], { id: "l1", footnoteId: "fn1", sourceId: "item-1", highlightId: "h1" }, NOW);
    assert.deepEqual(next.map((l) => l.id), ["l1"]);
  });

  test("removePassageLink removes only that highlight from that reference", () => {
    const a = link({ id: "l1", footnoteId: "fn1", highlightId: "h1" });
    const b = link({ id: "l2", footnoteId: "fn1", highlightId: "h2" });
    const c = link({ id: "l3", footnoteId: "fn2", highlightId: "h1" });
    assert.deepEqual(removePassageLink([a, b, c], "fn1", "h1"), [b, c]);
    const same = [a];
    assert.equal(removePassageLink(same, "fn1", "h2"), same);
  });

  test("referenceLocator formats single and multiple pages in order", () => {
    assert.equal(referenceLocator([link({ id: "l1", page: "12" })]), "p. 12");
    assert.equal(referenceLocator([]), null);
    const multi = ["15", "12", "15"].map((page, i) => link({ id: `l${i}`, footnoteId: "fn1", highlightId: `h${i}`, page }));
    assert.equal(referenceLocator(multi), "pp. 12, 15");
    const dup = ["4", "4"].map((page, i) => link({ id: `l${i}`, page }));
    assert.equal(referenceLocator(dup), "p. 4");
  });

  test("referenceCount counts links on one footnote once", () => {
    const links = [
      link({ id: "l1", footnoteId: "fn1", highlightId: "h1" }),
      link({ id: "l2", footnoteId: "fn1", highlightId: "h2" }),
      link({ id: "l3" }),
    ];
    assert.equal(referenceCount(links), 2);
  });

  test("older devices keep every link through normalising and removeLinksForFootnote clears them", () => {
    const links = [
      link({ id: "l1", footnoteId: "fn1", highlightId: "h1" }),
      link({ id: "l2", footnoteId: "fn1", highlightId: "h2" }),
    ];
    const roundTripped = normaliseSourceLinks(JSON.parse(JSON.stringify(links)));
    assert.deepEqual(passageHighlightIds(roundTripped, "fn1"), ["h1", "h2"]);
    assert.deepEqual(removeLinksForFootnote(links, "fn1"), []);
  });

  test("highlightReferences parses keys, groups essays per highlight, and sorts in reading order", () => {
    assert.deepEqual(essayKeyParts("assessment:m1"), { moduleId: "m1", essayId: "default" });
    assert.deepEqual(essayKeyParts("assessment:m1:e2"), { moduleId: "m1", essayId: "e2" });
    assert.equal(essayKeyParts("assessment-notes:m1"), null);
    assert.equal(essayKeyParts("assessment:"), null);

    const modules = [
      { id: "m1", code: "HIST1", deleted: false },
      { id: "m2", code: "", deleted: true },
    ];
    const rowLink = (id: string, sourceId: string, highlightId?: string, footnoteId = "fn1") => ({
      id,
      sourceId,
      footnoteId,
      ...(highlightId ? { highlightId } : {}),
    });
    const rows: EssaySettingRow[] = [
      { id: "assessment:m1", value: { title: "War and memory", sourceLinks: [rowLink("l1", "r1", "h1"), rowLink("l2", "r1", "h1", "fn2"), rowLink("l3", "r1", "h2")] } },
      { id: "assessment:m1:e2", value: { title: "", sourceLinks: [rowLink("l4", "r1", "h1")] } },
      { id: "assessment:m1:e3", deleted: true, value: { sourceLinks: [rowLink("l5", "r1", "h3")] } },
      { id: "assessment:m2", value: { sourceLinks: [rowLink("l6", "r1", "h3")] } },
    ];
    const found = referencesByHighlight(rows, modules, "r1");
    assert.deepEqual(found.get("h1"), [
      { moduleId: "m1", essayId: "default", essayTitle: "War and memory" },
      { moduleId: "m1", essayId: "e2", essayTitle: "HIST1 Essay" },
    ]);
    assert.equal(found.get("h2")?.length, 1);
    assert.equal(found.get("h3"), undefined);

    const ref = (essayTitle: string) => ({ moduleId: "m1", essayId: "e", essayTitle });
    assert.equal(referencedInLabel(undefined), null);
    assert.equal(referencedInLabel([ref("A")]), "Referenced in \u201cA\u201d");
    assert.equal(referencedInLabel([ref("A"), ref("B")]), "Referenced in \u201cA\u201d and \u201cB\u201d");
    assert.equal(referencedInLabel([ref("A"), ref("B"), ref("C")]), "Referenced in \u201cA\u201d, \u201cB\u201d and \u201cC\u201d");

    const ordered = inReadingOrder([
      { id: "low", page: 1, rects: [[0, 100, 10, 120]] },
      { id: "high", page: 1, rects: [[0, 600, 10, 620]] },
      { id: "first", page: 0, rects: [[0, 10, 10, 20]] },
      { id: "empty", page: 2, rects: [] },
    ]);
    assert.deepEqual(ordered.map((r) => r.id), ["first", "high", "low", "empty"]);
  });

  test("router passage mode round-trips through href and parseRoute", () => {
    const cite = { module: "m1", essay: "e2", footnote: "fn-1" };
    const route = routeOf(href({ view: "reader", id: "r1", page: 3, cite, passage: true }));
    assert.equal(route.view, "reader");
    if (route.view === "reader") {
      assert.equal(route.id, "r1");
      assert.equal(route.page, 3);
      assert.deepEqual(route.cite, cite);
      assert.equal(route.passage, true);
    }
    assert.equal("passage" in parseRoute("?v=reader&id=r1&pv=1"), false);
    assert.equal("passage" in parseRoute("?v=reader&id=r1&cm=m1&cf=fn-1"), false);
    assert.equal("passage" in parseRoute("?v=reader&id=r1&cm=m1&cf=fn-1&pv=0"), false);
    assert.equal(href({ view: "reader", id: "r1", passage: true }).includes("pv="), false);
    assert.equal(href({ view: "reader", id: "r1", cite }).includes("pv="), false);
  });
}
