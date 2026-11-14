// Unit tests for the reader polish work. Run with: npx tsx tests/reader-polish.unit.ts
// Self-contained in the style of tests/run.ts, so it needs no test framework.
import assert from "node:assert/strict";
import { anchorScroll, canvasScale, clampZoom, fitScale, largestPage, MAX_CANVAS_PIXELS, stepZoom, ZOOM_MAX, ZOOM_MIN } from "../src/lib/zoom";
import { COMMENT_MAX, commentWriter, normaliseComment } from "../src/lib/highlightComments";
import { isDuplicate, isHighlightable, normaliseBody, shortcutFor } from "../src/lib/highlightSelect";
import { reconcileShape } from "../src/lib/noteShape";

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
