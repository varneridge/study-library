// The rules behind the notes editor, collapsible questions, and the week's reading lists,
// together with the essay editor's status bar and its preview's zoom, dragging between
// nested lists, an essay's attached papers, and where each of its notes is cited.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { normaliseAssessmentData } from "../src/lib/assessment";
import { listCollision, listContextId, mayStartDrag } from "../src/lib/drag";
import { findCitationContext, sentenceBefore } from "../src/lib/essaySources";
import { foldedBlockIds, foldOwners, foldStyles, type FoldBlock } from "../src/lib/folds";
import {
  BLOCK_TYPES, blockFixes, headingUpgrades, isBlockMoveShortcut, noteVariant, removedMessage, SLASH_KEYS, typeSelectItems,
  type RuleChange,
} from "../src/lib/noteRules";
import { DROP_ZONE, groupByKind, isReadingKind, kindMenuItems, READING_KINDS } from "../src/lib/readingKinds";
import { answerPreview, questionKey, readQuestionOpen, writeQuestionOpen } from "../src/lib/questionFold";
import { splitQuestions } from "../src/lib/questionText";
import { BACK_LABEL_MIN_WIDTH, dockGeometry, INSETS_COMPACT, INSETS_REGULAR, parseChrome, parseSelectionWords, selectionWordCount, STRIP_MARGIN_START } from "../src/lib/wordcraftChrome";
import { centredScroll } from "../src/lib/zoom";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.has(key) ? this.values.get(key)! : null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

const heading = (id: string, level: number, folded = false): FoldBlock => ({ id, type: "heading", level, toggleable: true, open: !folded });
const para = (id: string): FoldBlock => ({ id, type: "paragraph" });

// A droppable as dnd-kit's collision functions read it, with its rectangle.
const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
type Box = ReturnType<typeof box>;
function collide(pointer: { x: number; y: number }, drops: { id: string; data: Record<string, unknown>; rect: Box }[]): string | undefined {
  const droppableContainers = drops.map((d) => ({ id: d.id, key: d.id, data: { current: d.data }, disabled: false, node: { current: null }, rect: { current: d.rect } }));
  const args = {
    active: { id: "dragged", data: { current: {} }, rect: { current: { initial: null, translated: null } } },
    collisionRect: box(pointer.x - 5, pointer.y - 5, 10, 10),
    droppableRects: new Map(drops.map((d) => [d.id, d.rect])),
    droppableContainers,
    pointerCoordinates: pointer,
  };
  return listCollision(args as never)[0]?.id as string | undefined;
}
const row = (id: string, list: string, rect: Box) => ({ id, data: { sortable: { containerId: listContextId(list) } }, rect });

// Runs the WordCraft bridge as a hosted page with a stand-in editor whose
// selection the test sets, firing its listeners and its timers at once.
function hostedBridge(selection: () => unknown) {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const sent: unknown[] = [];
  const settled = (value: unknown) => ({
    then(ok?: (v: unknown) => void) { ok?.(value); return this; },
    catch() { return this; },
  });
  const page = {
    parent: { postMessage: (message: unknown) => sent.push(message) },
    location: { search: "?host=parent&chrome=embedded", origin: "https://study.test" },
    wordcraft: { execute: (command: string) => settled(command === "edit.selection" ? selection() : {}) },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
  };
  vm.runInNewContext(readFileSync(new URL("../public/wordcraft/host-bridge.js", import.meta.url), "utf8"), {
    window: page,
    document: { documentElement: { classList: { add() {}, toggle() {}, contains: () => true } }, visibilityState: "visible", getElementById: () => null },
    URLSearchParams,
    setTimeout: (fn: () => void) => { fn(); return 0; },
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
  });
  const release = () => (listeners.get("pointerup") ?? []).forEach((fn) => fn({ type: "pointerup", clientX: 400, clientY: 300 }));
  // Copied into this realm, since the bridge's objects carry the sandbox's own prototypes.
  const selections = () => JSON.parse(JSON.stringify(sent.filter((m) => (m as { type?: string }).type === "wordcraft:selection"))) as unknown[];
  return { release, selections };
}

export function registerNotesAndReadingsTests(test: (name: string, fn: () => void) => void) {
  test("folds: hides a folded heading's section up to next heading of same level", () => {
    const blocks = [heading("h1", 1), para("a"), heading("h2", 2, true), para("b"), heading("h3", 3), para("c"), heading("h2b", 2), para("d")];
    assert.deepEqual(foldedBlockIds(blocks), ["b", "h3", "c"]);
  });

  test("folds: lets a folded top-level heading hide lower headings until next top-level", () => {
    const blocks = [heading("one", 1, true), heading("two", 2), para("a"), heading("three", 3), heading("next", 1), para("b")];
    assert.deepEqual(foldedBlockIds(blocks), ["two", "a", "three"]);
  });

  test("folds: names the folded heading that hides each block, agreeing with foldedBlockIds", () => {
    const blocks = [heading("h1", 1), heading("f", 2, true), para("a"), heading("sub", 3), para("b"), heading("h2", 2), heading("g", 2, true), para("c")];
    const owners = foldOwners(blocks);
    assert.deepEqual([...owners.keys()], foldedBlockIds(blocks));
    assert.equal(owners.get("a"), "f");
    assert.equal(owners.get("sub"), "f");
    assert.equal(owners.get("c"), "g");
    assert.equal(owners.has("h2"), false);
  });

  test("folds: writes a scoped rule only when something is hidden", () => {
    assert.equal(foldStyles("s1", []), "");
    assert.equal(foldStyles("s1", ["a"]), '[data-fold-scope="s1"] .bn-block-outer[data-id="a"] { display: none; }');
  });

  test("noteRules: variant detection from target", () => {
    assert.equal(noteVariant({ item_id: "i" }), "reading");
    assert.equal(noteVariant({ session_id: "s" }), "session");
    assert.equal(noteVariant({ week_id: "w" }), "general");
    assert.equal(noteVariant({ question_id: "q" }), "general");
  });

  test("noteRules: session notes slash menu has the 10 allowed options including image", () => {
    const expected = ["bullet_list", "divider", "image", "numbered_list", "paragraph", "quote", "table", "toggle_heading", "toggle_heading_2", "toggle_heading_3"].sort();
    assert.deepEqual([...SLASH_KEYS.session].sort(), expected);
    for (const key of ["heading", "heading_2", "heading_3", "check_list", "code_block"]) {
      assert.equal(SLASH_KEYS.session.has(key), false);
    }
    assert.equal(SLASH_KEYS.general.has("image"), true);
  });

  test("noteRules: reading notes offers text and lists only", () => {
    assert.deepEqual([...SLASH_KEYS.reading].sort(), ["bullet_list", "numbered_list", "paragraph"]);
    assert.deepEqual([...BLOCK_TYPES.reading].sort(), ["bulletListItem", "highlight", "numberedListItem", "paragraph"]);
    assert.equal(BLOCK_TYPES.session.has("heading"), true);
    assert.equal(BLOCK_TYPES.session.has("image"), true);
  });

  test("noteRules: makes headings collapsible and at most level 3", () => {
    const changes: RuleChange[] = [
      { type: "insert", block: { id: "a", type: "heading", props: { level: 5, isToggleable: false } } },
      { type: "update", block: { id: "b", type: "heading", props: { level: 2, isToggleable: true } } },
    ];
    assert.deepEqual(blockFixes("session", changes), [{ op: "update", id: "a", props: { level: 3, isToggleable: true } }]);
  });

  test("noteRules: turns headings into text in reading notes", () => {
    const changes: RuleChange[] = [
      { type: "insert", block: { id: "h", type: "heading", props: { level: 1 } } },
      { type: "insert", block: { id: "q", type: "quote" } },
      { type: "insert", block: { id: "img", type: "image" } },
    ];
    assert.deepEqual(blockFixes("reading", changes), [
      { op: "update", id: "h", type: "paragraph", props: {} },
      { op: "update", id: "q", type: "paragraph", props: {} },
      { op: "remove", id: "img", blockType: "image" },
    ]);
  });

  test("noteRules: recognises block moving shortcuts", () => {
    assert.equal(isBlockMoveShortcut({ key: "ArrowUp", ctrlKey: true, metaKey: false, altKey: false }), true);
    assert.equal(isBlockMoveShortcut({ key: "ArrowDown", ctrlKey: false, metaKey: true, altKey: false }), true);
    assert.equal(isBlockMoveShortcut({ key: "ArrowRight", ctrlKey: true, metaKey: false, altKey: false }), true);
    assert.equal(isBlockMoveShortcut({ key: "ArrowUp", ctrlKey: true, metaKey: false, altKey: true }), false);
    assert.equal(isBlockMoveShortcut({ key: "ArrowUp", ctrlKey: false, metaKey: false, altKey: false }), false);
    assert.equal(isBlockMoveShortcut({ key: "a", ctrlKey: true, metaKey: false, altKey: false }), false);
  });

  test("noteRules: filters block type select choices", () => {
    const raw = [
      { name: "Paragraph", type: "paragraph" },
      { name: "Toggle Heading 1", type: "heading", props: { level: 1, isToggleable: true } },
      { name: "Toggle Heading 2", type: "heading", props: { level: 2, isToggleable: true } },
      { name: "Toggle Heading 3", type: "heading", props: { level: 3, isToggleable: true } },
      { name: "Toggle Heading 4", type: "heading", props: { level: 4, isToggleable: true } },
      { name: "Plain Heading 1", type: "heading", props: { level: 1, isToggleable: false } },
      { name: "Quote", type: "quote" },
      { name: "Code", type: "codeBlock" },
    ];
    const sessionItems = typeSelectItems("session", raw);
    assert.deepEqual(sessionItems.map((i) => i.name), ["Paragraph", "Heading 1", "Heading 2", "Heading 3", "Quote"]);
    const readingItems = typeSelectItems("reading", raw);
    assert.deepEqual(readingItems.map((i) => i.name), ["Paragraph"]);
  });

  test("readingKinds: always three groups in fixed order", () => {
    const items = [
      { id: "1", kind: "secondary" },
      { id: "2", kind: "primary" },
      { id: "3", kind: "secondary" },
      { id: "4", kind: "slides" },
    ];
    const groups = groupByKind(items, (i) => i.kind);
    assert.deepEqual(groups.map((g) => g.kind), ["primary", "secondary", "summary"]);
    assert.deepEqual(groups[0].views.map((v) => v.id), ["2"]);
    assert.deepEqual(groups[1].views.map((v) => v.id), ["1", "3"]);
    assert.deepEqual(groups[2].views, []);
  });

  test("readingKinds: offers move options for readings", () => {
    const labels = { primary: "Primary sources", secondary: "Secondary readings", summary: "Summaries" };
    const items = kindMenuItems("primary", labels, () => {});
    assert.deepEqual(items.map((i) => i.label), ["Move to secondary readings", "Move to summaries"]);
    assert.deepEqual(kindMenuItems("slides", labels, () => {}), []);
  });

  test("questionFold: default open, write open, answer preview", () => {
    const mem = new MemoryStorage();
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { value: mem, configurable: true, writable: true });
    try {
      assert.equal(readQuestionOpen("q1"), true);
      writeQuestionOpen("q1", false);
      assert.equal(readQuestionOpen("q1"), false);
      writeQuestionOpen("q1", true);
      assert.equal(readQuestionOpen("q1"), true);
    } finally {
      Object.defineProperty(globalThis, "localStorage", { value: original, configurable: true, writable: true });
    }

    assert.equal(answerPreview("Short answer"), "Short answer");
    assert.equal(
      answerPreview("This is a fairly long answer that discusses the diplomatic history of China and the Soviet Union in detail across several sentences."),
      "This is a fairly long answer that discusses the diplomatic history of China and the…",
    );
  });

  test("wordcraft: a selection shows as 'X of Y words', and only a positive whole count counts", () => {
    assert.equal(selectionWordCount(120, 1250), "120 of 1,250 words");
    assert.equal(selectionWordCount(1, 1), "1 of 1 word");
    // The total trails typing by the autosave delay, so it never reads below the selection.
    assert.equal(selectionWordCount(40, 30), "40 of 40 words");
    assert.equal(parseSelectionWords(7), 7);
    for (const bad of [0, -3, 2.5, Number.NaN, "7", null, undefined]) assert.equal(parseSelectionWords(bad), 0);
  });

  test("wordcraft: the Back label only shows where it cannot run on to Home", () => {
    const at = (insetStart: number) =>
      dockGeometry(parseChrome({ embedded: true, tabStrip: { insetStart } })).back;
    assert.equal(at(INSETS_REGULAR.tabStart).iconOnly, false, "the regular room keeps the label");
    assert.equal(at(INSETS_REGULAR.tabStart).width, BACK_LABEL_MIN_WIDTH);
    assert.equal(at(INSETS_COMPACT.tabStart).iconOnly, true);
    assert.equal(at(BACK_LABEL_MIN_WIDTH - STRIP_MARGIN_START - 1).iconOnly, true, "a room just short of the label drops it");
    assert.equal(dockGeometry(null).back.iconOnly, false);
  });

  test("wordcraft: the stage keeps clear of safe areas and the Back dock clips its label", () => {
    const css = readFileSync(new URL("../src/components/WordProcessor.css", import.meta.url), "utf8");
    assert.match(css, /\.word-processor \{[^}]*env\(safe-area-inset-top/);
    assert.match(css, /\.wp-dock--back \{[^}]*overflow: hidden/);
    const source = readFileSync(new URL("../src/components/WordProcessor.tsx", import.meta.url), "utf8");
    assert.ok(source.includes('case "wordcraft:selection"'), "the editor reports its selection");
    assert.ok(!source.includes("function formatWordCount"), "the total uses wordProgress rather than a copy of it");
  });

  test("wordcraft bridge: tells the parent how many words are selected, and only when that changes", () => {
    let selection: unknown = { text: "" };
    const bridge = hostedBridge(() => selection);
    bridge.release();
    assert.deepEqual(bridge.selections(), [], "nothing selected at the start says nothing");
    selection = { text: "  Austria-Hungary issued the\nultimatum " };
    bridge.release();
    bridge.release();
    selection = 7;
    bridge.release();
    selection = { words: 2.5 };
    bridge.release();
    assert.deepEqual(bridge.selections(), [
      { type: "wordcraft:selection", words: 4 },
      { type: "wordcraft:selection", words: 7 },
      { type: "wordcraft:selection", words: 0 },
    ]);
  });

  test("drag: a row that is itself a control can still be picked up, but not from a control inside it", () => {
    const rowEl = { contains: () => true };
    const press = (control: unknown) => ({
      currentTarget: rowEl,
      nativeEvent: { isPrimary: true, button: 0, pointerType: "mouse", target: { closest: () => control } },
    }) as never;
    assert.equal(mayStartDrag(press(rowEl)), true, "the row matching NO_DRAG is not a control of its own");
    assert.equal(mayStartDrag(press({ tagName: "INPUT" })), false, "a field inside the row still keeps its typing");
  });

  test("drag: a list inside a larger droppable wins over it, and the container still wins elsewhere", () => {
    const card = { id: "card", data: {}, rect: box(0, 0, 400, 600) };
    const primary = { id: "list-primary", data: { list: "primary" }, rect: box(10, 100, 380, 200) };
    const rows = [row("p1", "primary", box(10, 110, 380, 40)), row("p2", "primary", box(10, 160, 380, 40))];
    assert.equal(collide({ x: 200, y: 175 }, [card, primary, ...rows]), "p2", "the inner list and its nearest row decide");
    assert.equal(collide({ x: 200, y: 500 }, [card, primary, ...rows]), "card", "outside the list, the card it sits in wins");

    const all = { id: "list-all", data: { list: "all" }, rect: box(0, 0, 400, 600) };
    const outerRow = row("o1", "all", box(10, 400, 380, 40));
    assert.equal(collide({ x: 200, y: 115 }, [all, primary, outerRow, ...rows]), "p1", "a nested list beats the list around it");
  });

  test("assessment: attached papers survive normalising, and a malformed one is dropped", () => {
    const brief = { id: "a1", name: "HY248 essay brief.pdf", size: 48213, mime: "application/pdf", r2Key: "files/a1" };
    const kept = normaliseAssessmentData({ title: "HY248 Essay", adminDocuments: [brief, { id: "a2", name: "Rubric" }, null] });
    assert.deepEqual(kept.adminDocuments, [brief]);
    assert.equal("adminDocuments" in normaliseAssessmentData({ title: "HY248 Essay" }), false, "an essay without papers is unchanged");
  });

  test("essaySources: the sentence before a citation, and where a note is cited", () => {
    const text = "Grey hesitated. Berlin, c. 1914, gave Vienna its \u201cblank cheque.\u201d The rest followed";
    assert.equal(sentenceBefore(text, text.indexOf(" The rest")), "Berlin, c. 1914, gave Vienna its \u201cblank cheque.\u201d");
    assert.equal(sentenceBefore(text, text.indexOf(",")), "Berlin");
    assert.equal(sentenceBefore("One. Two.", Number.NaN), "");
    assert.equal(sentenceBefore("One. Two.", 1e9), "Two.");

    const doc = {
      blocks: [
        { id: "b1", type: "heading1" as const, runs: [{ type: "text" as const, text: "Introduction" }] },
        { id: "b2", type: "paragraph" as const, runs: [
          { type: "text" as const, text: "Austria-Hungary issued the ultimatum." },
          { type: "footnote_ref" as const, footnoteId: "fn-a" },
          { type: "text" as const, text: " Serbia replied within two days, " },
          { type: "footnote_ref" as const, footnoteId: "fn-b" },
          { type: "text" as const, text: "and Russia mobilised." },
        ] },
      ],
      footnotes: [{ id: "fn-a", text: "Clark, Sleepwalkers, 412." }, { id: "fn-b", text: "Clark, Sleepwalkers, 450." }],
      comments: [],
    };
    assert.deepEqual(findCitationContext(doc as never, "fn-a"), { blockId: "b2", sentence: "Austria-Hungary issued the ultimatum." });
    assert.deepEqual(findCitationContext(doc as never, 2), { blockId: "b2", sentence: "Serbia replied within two days," });
    assert.equal(findCitationContext(doc as never, "fn-missing"), null);
    assert.equal(findCitationContext(doc as never, 3), null);
  });

  test("zoom: a zoom control keeps the centre of the preview where it was", () => {
    const frame = { width: 800, height: 1100 };
    const content = { width: 800, height: 5000 };
    const start = { left: 0, top: 1000 };
    assert.deepEqual(centredScroll(start, frame, content, 1, 1), start);
    assert.deepEqual(centredScroll(start, frame, content, 1, 2), { left: 400, top: 2550 });
    // Zoomed out, the narrower pages are centred, so there is nothing to scroll across.
    assert.deepEqual(centredScroll(start, frame, content, 1, 0.5), { left: 0, top: 225 });
    // Out and back again returns to the same place.
    const out = centredScroll(start, frame, content, 1, 2);
    assert.deepEqual(centredScroll(out, frame, content, 2, 1), start);
    // Never beyond what the frame can scroll, and never NaN from a bad scale.
    assert.deepEqual(centredScroll({ left: 0, top: 4000 }, frame, content, 1, 0.25), { left: 0, top: 150 });
    assert.deepEqual(centredScroll(start, frame, content, Number.NaN, 2), start);
  });
}
