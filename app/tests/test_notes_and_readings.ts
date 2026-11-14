// The rules behind the notes editor, collapsible questions, and the week's reading lists.

import assert from "node:assert/strict";
import { foldedBlockIds, foldOwners, foldStyles, type FoldBlock } from "../src/lib/folds";
import {
  BLOCK_TYPES, blockFixes, headingUpgrades, isBlockMoveShortcut, noteVariant, removedMessage, SLASH_KEYS, typeSelectItems,
  type RuleChange,
} from "../src/lib/noteRules";
import { DROP_ZONE, groupByKind, isReadingKind, kindMenuItems, READING_KINDS } from "../src/lib/readingKinds";
import { answerPreview, questionKey, readQuestionOpen, writeQuestionOpen } from "../src/lib/questionFold";
import { splitQuestions } from "../src/lib/questionText";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.has(key) ? this.values.get(key)! : null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

const heading = (id: string, level: number, folded = false): FoldBlock => ({ id, type: "heading", level, toggleable: true, open: !folded });
const para = (id: string): FoldBlock => ({ id, type: "paragraph" });

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

  test("noteRules: session notes slash menu has exactly the 9 allowed options", () => {
    const expected = ["bullet_list", "divider", "numbered_list", "paragraph", "quote", "table", "toggle_heading", "toggle_heading_2", "toggle_heading_3"].sort();
    assert.deepEqual([...SLASH_KEYS.session].sort(), expected);
    for (const key of ["heading", "heading_2", "heading_3", "image", "check_list", "code_block"]) {
      assert.equal(SLASH_KEYS.session.has(key), false);
    }
    assert.equal(SLASH_KEYS.general.has("image"), true);
  });

  test("noteRules: reading notes offers text and lists only", () => {
    assert.deepEqual([...SLASH_KEYS.reading].sort(), ["bullet_list", "numbered_list", "paragraph"]);
    assert.deepEqual([...BLOCK_TYPES.reading].sort(), ["bulletListItem", "highlight", "numberedListItem", "paragraph"]);
    assert.equal(BLOCK_TYPES.session.has("heading"), true);
    assert.equal(BLOCK_TYPES.session.has("image"), false);
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
}
