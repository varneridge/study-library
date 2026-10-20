// Notes are stored block by block, so an edit on one device only overwrites
// the paragraphs it touched.

import { db } from "./db";
import { byPosition, keyBetween } from "./keys";
import { commit, newId, type Change } from "./sync";
import type { Block, NoteBlockRow, NoteRow } from "./types";

export type NoteTarget = { session_id: string } | { item_id: string } | { question_id: string } | { week_id: string };

export function targetKey(target: NoteTarget): string {
  return Object.entries(target)[0].join(":");
}

export async function findNote(target: NoteTarget): Promise<NoteRow | null> {
  const [field, value] = Object.entries(target)[0];
  const notes = (await db.notes.where(field).equals(value).toArray()).filter((n) => !n.deleted);
  return notes.sort((a, b) => a.modified_at.localeCompare(b.modified_at))[0] ?? null;
}

export async function noteBlocks(noteId: string): Promise<NoteBlockRow[]> {
  return (await db.note_blocks.where("note_id").equals(noteId).toArray()).filter((b) => !b.deleted).sort(byPosition);
}

export function blockText(block: Block): string {
  const own = (block.content ?? [])
    .map((node) => (node.type === "link" ? node.content.map((c) => c.text).join("") : node.text))
    .join("");
  const props = block.type === "highlight" ? String(block.props?.text ?? "") : "";
  return [own, props, ...(block.children ?? []).map(blockText)].filter(Boolean).join(" ");
}

export function isEmpty(blocks: Block[]): boolean {
  return blocks.every((b) => b.type === "paragraph" && !blockText(b).trim());
}

export interface Saved {
  position: string;
  json: string;
  row: NoteBlockRow;
}

// Keeps as many existing positions as possible and gives new keys only to
// blocks that were added or moved. The kept blocks are the longest run whose
// positions are already in order, so moving one block rewrites one row.
export function positionsFor(ids: string[], saved: Map<string, Saved>): string[] {
  const known = ids
    .map((id, index) => ({ index, position: saved.get(id)?.position }))
    .filter((entry): entry is { index: number; position: string } => entry.position !== undefined);
  const tails: number[] = [];
  const previous: number[] = [];
  known.forEach((entry, k) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (known[tails[mid]].position < entry.position) low = mid + 1;
      else high = mid;
    }
    previous[k] = low > 0 ? tails[low - 1] : -1;
    tails[low] = k;
  });
  const keep = new Array<boolean>(ids.length).fill(false);
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = previous[k]) keep[known[k].index] = true;

  const out: string[] = [];
  let before: string | null = null;
  for (let i = 0; i < ids.length; i += 1) {
    if (keep[i]) {
      before = saved.get(ids[i])!.position;
      out.push(before);
      continue;
    }
    let next: string | null = null;
    for (let j = i + 1; j < ids.length; j += 1) {
      if (keep[j]) {
        next = saved.get(ids[j])!.position;
        break;
      }
    }
    before = keyBetween(before, next);
    out.push(before);
  }
  return out;
}

export async function saveNote(
  target: NoteTarget,
  noteId: string | null,
  blocks: Block[],
  saved: Map<string, Saved>,
): Promise<string | null> {
  if (!noteId && isEmpty(blocks)) return null;
  const changes: Change[] = [];
  const existing = noteId ? await db.notes.get(noteId) : await findNote(target);
  const id = existing?.id ?? noteId ?? newId();
  if (!existing) {
    changes.push({
      table: "notes",
      row: {
        id, session_id: null, item_id: null, question_id: null, week_id: null, zotero_key: null,
        ...target,
      } as NoteRow,
    });
  }
  const positions = positionsFor(blocks.map((b) => b.id), saved);
  const seen = new Set<string>();
  blocks.forEach((block, index) => {
    seen.add(block.id);
    const json = JSON.stringify(block);
    const previous = saved.get(block.id);
    if (previous && previous.json === json && previous.position === positions[index]) return;
    const row: NoteBlockRow = {
      ...(previous?.row ?? {}),
      id: block.id,
      note_id: id,
      position: positions[index],
      type: block.type,
      content: block,
      highlight_id: block.type === "highlight" ? String(block.props?.highlightId ?? "") || null : null,
      modified_at: "",
      deleted: false,
    };
    changes.push({ table: "note_blocks", row });
    saved.set(block.id, { position: positions[index], json, row });
  });
  for (const [blockId, previous] of saved) {
    if (!seen.has(blockId)) {
      changes.push({ table: "note_blocks", row: { ...previous.row, deleted: true } });
      saved.delete(blockId);
    }
  }
  await commit(changes);
  return id;
}

// Splits pasted seminar questions into one per line, dropping numbering.
// One question per line, with any numbering taken off: "1.", "2)", "(3)",
// "a)", a bullet, "Q3:" or "Question 4:". A number on its own, as in
// "1949 was the turning point?", is part of the question and stays.
const QUESTION_PREFIX = /^\s*(?:(?:Q(?:uestion)?\s*\d+[.):]?|\(?\d+[.):]\)?|\(?[a-z][.)])|[\u2022*-])\s*/i;

export function splitQuestions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(QUESTION_PREFIX, "").trim())
    .filter((line) => line.length > 2);
}
