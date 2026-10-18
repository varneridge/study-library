// A reading's notes hold its highlights. Each highlight sits in the notes as
// a quotation, placed in reading order: earlier in the text means earlier in
// the notes. Anything you write beneath a quotation stays with it, because a
// new quotation goes in before the next later one, never between a quotation
// and your writing.
//
// This keeps the two in step from the data, so it works whichever device
// made the highlight and whether or not the notes are open.

import { db } from "./db";
import { byPosition, keyBetween } from "./keys";
import { findNote } from "./notes";
import { commit, newId, type Change } from "./sync";
import type { Block, HighlightRow, NoteBlockRow } from "./types";

// Where a highlight falls in the reading: page first, then down the page.
export function readingOrder(h: Pick<HighlightRow, "page" | "rects">): number {
  const top = Math.max(...h.rects.map((r) => r[3]), 0);
  return h.page * 100000 - top;
}

function quote(h: HighlightRow): Block {
  return {
    id: newId(),
    type: "highlight",
    props: { highlightId: h.id, itemId: h.item_id, page: h.page, text: h.body ?? "", colour: h.colour, source: "" },
    children: [],
  };
}

function paragraph(text: string): Block {
  return { id: newId(), type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] };
}

let running: Promise<void> | null = null;

// Adds quotations for new highlights, removes those whose highlight has
// gone, and keeps colours and text current. A comment written before notes
// held highlights moves into the notes beneath its quotation, once.
export function reconcile(itemId: string): Promise<void> {
  // One at a time, so two quick highlights cannot both take the same place.
  const next = (running ?? Promise.resolve()).then(() => run(itemId)).catch(() => undefined);
  running = next;
  return next;
}

async function run(itemId: string): Promise<void> {
  const highlights = (await db.highlights.where("item_id").equals(itemId).toArray()).filter((h) => !h.deleted);
  let note = await findNote({ item_id: itemId });
  const changes: Change[] = [];
  if (!note) {
    if (!highlights.length) return;
    note = { id: newId(), session_id: null, item_id: itemId, question_id: null, zotero_key: null, modified_at: "", deleted: false };
    changes.push({ table: "notes", row: note });
  }
  const blocks: NoteBlockRow[] = note.modified_at
    ? (await db.note_blocks.where("note_id").equals(note.id).toArray()).filter((b) => !b.deleted).sort(byPosition)
    : [];
  const live = new Map(highlights.map((h) => [h.id, h]));
  const placed = new Map<string, NoteBlockRow>();

  for (const row of blocks) {
    if (row.type !== "highlight") continue;
    const id = String(row.content.props?.highlightId ?? "");
    const h = live.get(id);
    if (!h || placed.has(id)) {
      // The highlight was deleted, or this is a second copy of it.
      changes.push({ table: "note_blocks", row: { ...row, deleted: true } });
      continue;
    }
    placed.set(id, row);
    const props = row.content.props ?? {};
    if (props.colour !== h.colour || props.text !== (h.body ?? "") || props.page !== h.page) {
      changes.push({
        table: "note_blocks",
        row: { ...row, content: { ...row.content, props: { ...props, colour: h.colour, text: h.body ?? "", page: h.page } } },
      });
    }
  }

  const missing = highlights.filter((h) => !placed.has(h.id)).sort((a, b) => readingOrder(a) - readingOrder(b));
  if (missing.length) {
    // Work on an ordered list of what will be there, so each new quotation
    // lands in the right place relative to those added before it.
    const order = blocks.filter((b) => !(b.type === "highlight" && !placed.has(String(b.content.props?.highlightId))));
    const keyOf = (b: NoteBlockRow) => (b.type === "highlight" ? readingOrder(live.get(String(b.content.props?.highlightId))!) : null);
    for (const h of missing) {
      const k = readingOrder(h);
      const at = order.findIndex((b) => { const bk = keyOf(b); return bk !== null && bk > k; });
      const index = at < 0 ? order.length : at;
      const before = order[index - 1]?.position ?? null;
      const after = order[index]?.position ?? null;
      const added: NoteBlockRow[] = [];
      const content = quote(h);
      let position = keyBetween(before, after);
      added.push({ id: content.id, note_id: note.id, position, type: "highlight", content, highlight_id: h.id, modified_at: "", deleted: false });
      if (h.comment?.trim()) {
        const p = paragraph(h.comment.trim());
        position = keyBetween(position, after);
        added.push({ id: p.id, note_id: note.id, position, type: "paragraph", content: p, highlight_id: null, modified_at: "", deleted: false });
        changes.push({ table: "highlights", row: { ...h, comment: null } });
      }
      order.splice(index, 0, ...added);
      for (const row of added) changes.push({ table: "note_blocks", row });
    }
  }
  if (changes.length) await commit(changes);
}
