// Unit tests for the reader polish work. Run with: npx tsx tests/reader-polish.unit.ts
// Self-contained in the style of tests/run.ts, so it needs no test framework.
import assert from "node:assert/strict";
import { anchorScroll, canvasScale, clampZoom, fitScale, largestPage, MAX_CANVAS_PIXELS, stepZoom, ZOOM_MAX, ZOOM_MIN } from "../src/lib/zoom";
import { COMMENT_MAX, commentWriter, normaliseComment } from "../src/lib/highlightComments";
import { isDuplicate, isHighlightable, normaliseBody, selectionKey, shortcutFor, spaceTogglesAudio, unionRect } from "../src/lib/highlightSelect";
import { placeSelectionBar } from "../src/components/reader/SelectionBar";
import { reconcileShape } from "../src/lib/noteShape";
import { headingsOf, reflow, tableBoxes, type Block, type Line } from "../src/lib/reflow";
import type { PDFDocumentProxy } from "pdfjs-dist";

let failed = 0;
const queue: Array<[string, () => void | Promise<void>]> = [];
function test(name: string, fn: () => void | Promise<void>) {
  queue.push([name, fn]);
}

const A4 = { width: 595, height: 842 };
const SLIDE = { width: 960, height: 540 };

test("fitting a page uses the tighter of the two axes", () => {
  const s = fitScale({ width: 800, height: 600 }, A4, "page", 0);
  assert.ok(Math.abs(s - 600 / 842) < 1e-9);
  const w = fitScale({ width: 800, height: 600 }, A4, "width", 0);
  assert.ok(Math.abs(w - 800 / 595) < 1e-9);
});

test("a slide fits its frame by width when the frame is tall", () => {
  const s = fitScale({ width: 400, height: 900 }, SLIDE, "page", 0);
  assert.ok(Math.abs(s - 400 / 960) < 1e-9);
});

test("an unmeasured frame or page fits at 100 per cent", () => {
  assert.equal(fitScale({ width: 0, height: 0 }, A4, "page"), 1);
  assert.equal(fitScale({ width: 800, height: 600 }, { width: 0, height: 0 }, "width"), 1);
  assert.equal(fitScale({ width: Number.NaN, height: 600 }, A4, "width"), 1);
});

test("zoom is clamped and never NaN", () => {
  assert.equal(clampZoom(Number.NaN), 1);
  assert.equal(clampZoom(-2), 1);
  assert.equal(clampZoom(100), ZOOM_MAX);
  assert.equal(clampZoom(0.01), ZOOM_MIN);
});

test("stepping moves to the next step in the asked direction, from between steps too", () => {
  assert.equal(stepZoom(1, 1), 1.1);
  assert.equal(stepZoom(1, -1), 0.9);
  assert.equal(stepZoom(1.03, 1), 1.1);
  assert.equal(stepZoom(1.03, -1), 1);
  assert.equal(stepZoom(ZOOM_MAX, 1), ZOOM_MAX);
  assert.equal(stepZoom(0.3, -1), 0.5);
});

test("the point under focus stays under focus across a change of scale", () => {
  const before = { left: 100, top: 300 };
  const focal = { x: 200, y: 150 };
  const after = anchorScroll(before, focal, 1, 2);
  // Content point under focus before: (300, 450) at scale 1, so (600, 900) at scale 2.
  assert.deepEqual(after, { left: 400, top: 750 });
  assert.deepEqual(anchorScroll({ left: 0, top: 0 }, { x: 10, y: 10 }, 2, 1), { left: 0, top: 0 });
});

test("the largest page is measured across mixed sizes", () => {
  assert.deepEqual(largestPage([A4, SLIDE]), { width: 960, height: 842 });
  assert.deepEqual(largestPage([]), { width: 1, height: 1 });
});

test("a canvas never exceeds the pixel ceiling", () => {
  const s = canvasScale(A4, 4, 3);
  assert.ok(A4.width * s * A4.height * s <= MAX_CANVAS_PIXELS + 1);
  assert.equal(canvasScale(A4, 1, 2), 2);
});

test("comments are normalised before they are stored", () => {
  assert.equal(normaliseComment("  "), null);
  assert.equal(normaliseComment(""), null);
  assert.equal(normaliseComment(null), null);
  assert.equal(normaliseComment("  keep leading\n\n"), "  keep leading");
  assert.equal(normaliseComment("x".repeat(COMMENT_MAX + 5))?.length, COMMENT_MAX);
});

test("keystrokes coalesce into one write per highlight", async () => {
  const writes: Array<[string, string | null]> = [];
  const w = commentWriter(async (id, c) => void writes.push([id, c]), 20);
  w.set("a", "f");
  w.set("a", "fo");
  w.set("b", "x");
  w.set("a", "foo");
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(writes.sort(), [["a", "foo"], ["b", "x"]]);
});

test("flush writes at once and an unchanged value is not written twice", async () => {
  const writes: Array<[string, string | null]> = [];
  const w = commentWriter(async (id, c) => void writes.push([id, c]), 10_000);
  w.set("a", "note");
  assert.ok(w.pending("a"));
  await w.flush("a");
  assert.deepEqual(writes, [["a", "note"]]);
  w.set("a", "note  ");
  await w.flush();
  assert.equal(writes.length, 1);
  await w.dispose();
});

test("a failed write keeps its draft so the next flush retries it", async () => {
  let fail = true;
  const writes: string[] = [];
  const w = commentWriter(async (_id, c) => {
    if (fail) throw new Error("QuotaExceededError");
    writes.push(String(c));
  }, 10_000);
  w.set("a", "kept");
  await assert.rejects(w.flush("a"));
  assert.ok(w.pending("a"));
  fail = false;
  await w.flush("a");
  assert.deepEqual(writes, ["kept"]);
});

test("the notes' shape ignores comments, so typing in a card never rewrites the notes", () => {
  const h = { id: "h1", colour: "yellow", page: 2, body: "text", comment: "one" };
  const before = reconcileShape([h]);
  const after = reconcileShape([{ ...h, comment: "one two" } as typeof h]);
  assert.equal(before, after);
  assert.notEqual(reconcileShape([{ ...h, colour: "blue" }]), before);
  assert.equal(reconcileShape(undefined), "");
});

test("selections compare equal across PDF hyphenation and spacing", () => {
  assert.equal(normaliseBody("enlight-\n ened  absolut\u00adism"), "enlightened absolutism");
});

test("a selection inside an existing highlight on the same page is a duplicate", () => {
  const existing = [{ id: "h1", page: 1, body: "The reformers forged a distinctive hybrid" }];
  assert.ok(isDuplicate(existing, { page: 1, body: "forged a  distinctive" }));
  assert.ok(!isDuplicate(existing, { page: 2, body: "forged a distinctive" }));
  assert.ok(!isDuplicate([{ ...existing[0], deleted: true }], { page: 1, body: "forged" }));
  assert.ok(isDuplicate(existing, { page: 1, body: "   " }));
});

test("only selections with letters or digits are offered", () => {
  assert.ok(isHighlightable({ page: 0, body: "word" }));
  assert.ok(!isHighlightable({ page: 0, body: " \n " }));
});

test("selection shortcuts apply only when they should", () => {
  assert.equal(shortcutFor({ key: "h" }, false, true), "highlight");
  assert.equal(shortcutFor({ key: "H" }, false, true), "highlight");
  assert.equal(shortcutFor({ key: "c" }, false, true), "comment");
  assert.equal(shortcutFor({ key: "h" }, true, true), null);
  assert.equal(shortcutFor({ key: "h", repeat: true }, false, true), null);
  assert.equal(shortcutFor({ key: "h", ctrlKey: true }, false, true), null);
  assert.equal(shortcutFor({ key: "h" }, false, false), null);
  assert.equal(shortcutFor({ key: "Escape" }, true, true), "dismiss");
});

test("the selection box holds every usable line, not only the last", () => {
  const lines = [
    { left: 100, top: 100, right: 400, bottom: 118 },
    { left: 90, top: 118, right: 410, bottom: 136 },
    { left: 90, top: 136, right: 250, bottom: 154 },
    // Text that is not laid out reports a box of zeros, and a broken one, NaN.
    { left: 0, top: 0, right: 0, bottom: 0 },
    { left: Number.NaN, top: 0, right: 10, bottom: 10 },
  ];
  assert.deepEqual(unionRect(lines), { left: 90, top: 100, right: 410, bottom: 154 });
  assert.equal(unionRect([]), null);
  assert.equal(unionRect([lines[3], lines[4]]), null);
});

test("a selection key changes when any edge of the selection box moves", () => {
  const base = { page: 1, text: "some words", rects: [[1, 2, 3, 4]], box: { left: 10, top: 20, right: 30, bottom: 40 } };
  assert.equal(selectionKey(base), selectionKey({ ...base, box: { ...base.box } }));
  for (const edge of ["left", "top", "right", "bottom"] as const) {
    assert.notEqual(selectionKey(base), selectionKey({ ...base, box: { ...base.box, [edge]: base.box[edge] + 5 } }), edge);
  }
});

test("the selection bar clears a tall selection, above it where there is room and below it where there is not", () => {
  const bar = { width: 300, height: 40 };
  const desktop = { width: 1280, height: 800 };
  const tall = { left: 200, top: 300, right: 700, bottom: 360 };
  assert.ok(placeSelectionBar(tall, bar, desktop, false).top + bar.height <= tall.top, "above a tall selection");
  const high = { left: 200, top: 20, right: 700, bottom: 80 };
  assert.ok(placeSelectionBar(high, bar, desktop, false).top >= high.bottom, "below, when there is no room above");
  assert.ok(placeSelectionBar(tall, bar, desktop, true).top >= tall.bottom, "below on a touch screen");
  const phone = placeSelectionBar({ left: 20, top: 400, right: 370, bottom: 460 }, { width: 340, height: 40 }, { width: 390, height: 844 }, false);
  assert.ok(phone.top + 40 <= 400, "above on a phone");
  assert.ok(phone.left >= 8 && phone.left + 340 <= 390 - 8, "inside the phone's width");
});

test("a bare Space toggles the audio, unless it is on a button or a field or carries a modifier", () => {
  const on = (tagName: string, extra: Record<string, unknown> = {}) => ({ key: " ", target: { tagName }, ...extra });
  assert.ok(spaceTogglesAudio({ key: " " }));
  assert.ok(spaceTogglesAudio(on("DIV")));
  assert.ok(spaceTogglesAudio({ key: "Spacebar", target: { tagName: "BODY" } }));
  for (const tag of ["BUTTON", "INPUT", "TEXTAREA", "SELECT"]) assert.ok(!spaceTogglesAudio(on(tag)), tag);
  assert.ok(!spaceTogglesAudio({ key: " ", target: { tagName: "DIV", isContentEditable: true } }));
  for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey"]) assert.ok(!spaceTogglesAudio(on("DIV", { [modifier]: true })), modifier);
  assert.ok(!spaceTogglesAudio({ key: "Enter", target: { tagName: "DIV" } }));
});

// A page of the kind an OCR text layer gives: one item for each word, so that
// the page is read as a scan. Lines are given as text, a baseline and, if
// wanted, a size and a left edge or "centre".
interface Row { text: string; y: number; size?: number; x?: number | "centre" }
function scanPage(rows: Row[]): Array<{ str: string; x: number; y: number; size: number }> {
  const out: Array<{ str: string; x: number; y: number; size: number }> = [];
  for (const row of rows) {
    const size = row.size ?? 12;
    const words = row.text.split(" ");
    const total = words.reduce((sum, w) => sum + w.length * size * 0.5 + size * 0.35, 0) - size * 0.35;
    let x = row.x === "centre" ? (612 - total) / 2 : row.x ?? 72;
    for (const str of words) {
      out.push({ str, x, y: row.y, size });
      x += str.length * size * 0.5 + size * 0.35;
    }
  }
  return out;
}

// A document of pages of positioned text, in the shape reflow reads from pdf.js.
function mockDoc(pages: Array<Array<{ str: string; x: number; y: number; size: number }>>): PDFDocumentProxy {
  return {
    numPages: pages.length,
    getPage: async (n: number) => ({
      getViewport: () => ({ width: 612, height: 792 }),
      getTextContent: async () => ({
        items: pages[n - 1].map((w) => ({ str: w.str, transform: [w.size, 0, 0, w.size, w.x, w.y], width: w.str.length * w.size * 0.5, height: w.size })),
      }),
    }),
  } as unknown as PDFDocumentProxy;
}

// Twelve words of running text, different on every line, so that no gap between words lines up down the page.
const POOL = "the council argued that trade between northern towns and coast depended on roads which were maintained by local landowners rather than officials appointed from capital".split(" ");
const prose = (k: number, last = false) => {
  const words = Array.from({ length: 12 }, (_, i) => POOL[(k * 7 + i * 3) % POOL.length]);
  if (last) words[11] = "towns.";
  return words.join(" ");
};
// A run of lines of text going down the page from a baseline, the last of them ending its sentence.
function run(rows: Row[], y: number, count: number, from: number): number {
  for (let i = 0; i < count; i += 1) { rows.push({ text: prose(from + i, i === count - 1), y }); y -= 14; }
  return y + 14;
}

test("a gap of more than four lines in the text of a scanned page is a figure with that gap as its box", async () => {
  const rows: Row[] = [];
  run(rows, 660, 12, 0);
  run(rows, 386, 8, 12);
  const r = await reflow(mockDoc([scanPage(rows)]));
  assert.deepEqual(r.blocks.map((b) => b.kind), ["para", "figure", "para"]);
  const fig = r.blocks[1];
  assert.equal(fig.lines.length, 0);
  assert.equal(fig.figure?.page, 0);
  const [, y0, , y1] = fig.figure!.box;
  // Last line above sits at 506 and the first below at 386.
  assert.ok(y0 > 386 && y0 < 410, `bottom edge ${y0}`);
  assert.ok(y1 < 506 && y1 > 490, `top edge ${y1}`);
  assert.ok(y1 - y0 > 14 * 4);
});

test("ordinary spacing on a scanned page is not taken for a figure", async () => {
  const rows: Row[] = [];
  run(rows, 660, 10, 0);
  run(rows, 534 - 28, 6, 10);
  const r = await reflow(mockDoc([scanPage(rows)]));
  assert.ok(!r.blocks.some((b) => b.kind === "figure"));
});

test("scanned pages: centred, capitalised, numbered and taller spaced lines are headings, and spaced ones only", async () => {
  const one: Row[] = [];
  let y = run(one, 660, 4, 0);
  one.push({ text: "The Rise of the Towns", y: y - 28, x: "centre" });
  y = run(one, y - 28 - 20, 4, 4);
  one.push({ text: "THE PEASANT REVOLT", y: y - 28 });
  y = run(one, y - 28 - 20, 4, 8);
  one.push({ text: "Background to the War", y: y - 28, size: 14.5 });
  run(one, y - 28 - 20, 4, 12);
  const two: Row[] = [];
  y = run(two, 660, 4, 16);
  two.push({ text: "2.3 Taxation and Trade", y: y - 28 });
  y = run(two, y - 28 - 20, 4, 20);
  two.push({ text: "II. Settlement of the Frontier", y: y - 28 });
  y = run(two, y - 28 - 20, 4, 24);
  // Centred, but with ordinary spacing above it, so it is the end of the prose.
  two.push({ text: "That was all.", y: y - 14, x: "centre" });
  const r = await reflow(mockDoc([scanPage(one), scanPage(two)]));
  const found = headingsOf(r.blocks);
  assert.deepEqual(found.map((h) => h.title), [
    "The Rise of the Towns", "THE PEASANT REVOLT", "Background to the War", "2.3 Taxation and Trade", "II. Settlement of the Frontier",
  ]);
  assert.deepEqual(found.map((h) => h.page), [0, 0, 0, 1, 1]);
  // A capitalised line and a roman numeral open a major part; 2.3 is a subsection.
  assert.equal(found[1].level, 2);
  assert.equal(found[3].level, 3);
  assert.ok(!r.blocks.some((b) => b.kind === "figure"), "the spaces above headings are not pictures");
});

test("a table block keeps its rows and gives one crop box for each page it covers", async () => {
  const rows: Array<{ str: string; x: number; y: number; size: number }> = [];
  for (let k = 0; k < 10; k += 1) rows.push({ str: prose(k, true), x: 72, y: 660 - k * 14, size: 12 });
  const table = [["Year", "Population", "Growth"], ["1990", "1200", "4.1"], ["2000", "1500", "5.0"], ["2010", "1900", "6.3"]];
  table.forEach((cells, i) => [72, 250, 420].forEach((x, c) => rows.push({ str: cells[c], x, y: 480 - i * 14, size: 12 })));
  const r = await reflow(mockDoc([rows]));
  const tables = r.blocks.filter((b) => b.kind === "table");
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].rows!.map((row) => row.map((c) => c.text.trim())), table);
  assert.equal(tables[0].lines.length, 12);
  const boxes = tableBoxes(tables[0]);
  assert.equal(boxes.length, 1);
  const [x0, y0, x1, y1] = boxes[0].box;
  assert.ok(x0 < 72 && x1 > 420 + 12 * 0.5 * 4, `across ${x0} to ${x1}`);
  assert.ok(y0 <= 480 - 3 * 14 && y1 >= 480, `down ${y0} to ${y1}`);
  const cell = (page: number, y: number): Line => ({ page, start: 0, end: 1, text: "x", hyphen: false, x0: 50, x1: 90, y, size: 10, colLeft: 0, colRight: 1 });
  const long: Block = { kind: "table", rows: [[cell(0, 100)], [cell(1, 700)]], lines: [cell(0, 100), cell(1, 700)] };
  assert.deepEqual(tableBoxes(long).map((b) => b.page), [0, 1]);
});

for (const [name, fn] of queue) {
  try {
    await fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${(err as Error).message}`);
  }
}
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log(`all ${queue.length} passed`);
