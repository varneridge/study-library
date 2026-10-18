import { moveToTray } from "./moves";
import { weekCode } from "./modules";
// Deleting and restoring.
//
// Every delete is soft: rows are marked deleted and kept for 90 days, so
// anything can come back. A delete takes the thing and everything inside
// it in one commit, with the parent first. Its children therefore carry a
// later edit time than the parent. Restoring brings back the children
// deleted at or after the parent, and leaves alone anything that was
// deleted on its own earlier.

import { db } from "./db";
import { byPosition, keysAfter } from "./keys";
import { commit, newId, type Change } from "./sync";
import { confirmAction, showToast } from "./ui";
import type { ItemRow, ModuleRow, QuestionRow, RecordingRow, SessionKind, SessionRow, TableName, Tables, WeekRow } from "./types";

type Row = Tables[TableName];
interface Ref { table: TableName; row: Row }

const all = <T>(rows: (T | undefined)[]) => rows.filter((r): r is T => Boolean(r));

async function noteTree(field: "session_id" | "item_id" | "question_id" | "week_id", ids: string[]): Promise<Ref[]> {
  if (!ids.length) return [];
  const notes = await db.notes.where(field).anyOf(ids).toArray();
  const blocks = notes.length ? await db.note_blocks.where("note_id").anyOf(notes.map((n) => n.id)).toArray() : [];
  return [...notes.map((row) => ({ table: "notes" as const, row })), ...blocks.map((row) => ({ table: "note_blocks" as const, row }))];
}

async function itemTree(items: ItemRow[]): Promise<Ref[]> {
  if (!items.length) return [];
  const ids = items.map((i) => i.id);
  const links = await db.week_items.where("item_id").anyOf(ids).toArray();
  const highlights = await db.highlights.where("item_id").anyOf(ids).toArray();
  return [
    ...items.map((row) => ({ table: "items" as const, row })),
    ...links.map((row) => ({ table: "week_items" as const, row })),
    ...highlights.map((row) => ({ table: "highlights" as const, row })),
    ...(await noteTree("item_id", ids)),
  ];
}

async function questionTree(questions: QuestionRow[]): Promise<Ref[]> {
  return [
    ...questions.map((row) => ({ table: "questions" as const, row })),
    ...(await noteTree("question_id", questions.map((q) => q.id))),
  ];
}

// Slides belong to their session, so they go with it. Readings in the
// week are left where they are.
async function sessionTree(sessions: SessionRow[]): Promise<Ref[]> {
  if (!sessions.length) return [];
  const ids = sessions.map((s) => s.id);
  const slideLinks = (await db.week_items.where("week_id").anyOf(sessions.map((s) => s.week_id)).toArray())
    .filter((l) => l.session_id && ids.includes(l.session_id));
  const slides = all(await db.items.bulkGet(slideLinks.map((l) => l.item_id)));
  const questions = await db.questions.where("session_id").anyOf(ids).toArray();
  const recordings = await db.recordings.where("session_id").anyOf(ids).toArray();
  return [
    ...sessions.map((row) => ({ table: "sessions" as const, row })),
    ...(await itemTree(slides)),
    ...(await questionTree(questions)),
    ...recordings.map((row) => ({ table: "recordings" as const, row })),
    ...(await noteTree("session_id", ids)),
  ];
}

async function moduleTree(module: ModuleRow): Promise<Ref[]> {
  const weeks = await db.weeks.where("module_id").equals(module.id).toArray();
  const weekIds = weeks.map((w) => w.id);
  const sessions = weekIds.length ? await db.sessions.where("week_id").anyOf(weekIds).toArray() : [];
  const links = weekIds.length ? await db.week_items.where("week_id").anyOf(weekIds).toArray() : [];
  const linked = all(await db.items.bulkGet([...new Set(links.map((l) => l.item_id))]));
  const tray = await db.items.where("tray_module_id").equals(module.id).toArray();
  const items = [...new Map([...linked, ...tray].map((i) => [i.id, i])).values()];
  return [
    { table: "modules", row: module },
    ...weeks.map((row) => ({ table: "weeks" as const, row })),
    ...(await sessionTree(sessions)),
    ...(await itemTree(items)),
  ];
}

function unique(refs: Ref[]): Ref[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.table}:${r.row.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface Deleted { refs: { table: TableName; id: string }[] }

async function softDelete(refs: Ref[]): Promise<Deleted> {
  const live = unique(refs).filter((r) => !r.row.deleted);
  await commit(live.map((r) => ({ table: r.table, row: { ...r.row, deleted: true } })));
  return { refs: live.map((r) => ({ table: r.table, id: r.row.id })) };
}

// Undo puts back exactly the rows one delete took.
export async function undo(deleted: Deleted): Promise<void> {
  const changes: Change[] = [];
  for (const ref of deleted.refs) {
    const row = (await db.table(ref.table).get(ref.id)) as Row | undefined;
    if (row?.deleted) changes.push({ table: ref.table, row: { ...row, deleted: false } });
  }
  await commit(changes);
}

async function restoreTree(root: Ref, refs: Ref[]): Promise<void> {
  const since = root.row.modified_at;
  const rows = unique(refs).filter((r) => r.row.deleted && (r.row.id === root.row.id || r.row.modified_at >= since));
  // Parent first, so nothing restored points at a missing row.
  await commit(rows.map((r) => ({ table: r.table, row: { ...r.row, deleted: false } })));
}

export const deleteModule = async (module: ModuleRow) => softDelete(await moduleTree(module));
export const deleteItem = async (item: ItemRow) => softDelete(await itemTree([item]));
export const deleteSession = async (session: SessionRow) => softDelete(await sessionTree([session]));
export const deleteQuestion = async (question: QuestionRow) => softDelete(await questionTree([question]));
export const deleteRecording = async (recording: RecordingRow) => softDelete([{ table: "recordings", row: recording }]);
export const deleteRows = async (refs: Ref[]) => softDelete(refs);

// Whether a session holds anything a person made.
export async function sessionHasContent(session: SessionRow): Promise<boolean> {
  const tree = await sessionTree([session]);
  return tree.some((r) => r.table !== "sessions" && !r.row.deleted);
}

// The bin

export interface BinEntry {
  key: string;
  kind: "module" | "reading" | "session" | "question" | "recording";
  label: string;
  context: string;
  deletedAt: string;
  restore: () => Promise<void>;
}

const BIN_DAYS = 90;

export async function loadBin(): Promise<BinEntry[]> {
  const cutoff = new Date(Date.now() - BIN_DAYS * 86_400_000).toISOString();
  const recent = <T extends { deleted: boolean; modified_at: string }>(rows: T[]) =>
    rows.filter((r) => r.deleted && r.modified_at >= cutoff);

  const modules = new Map((await db.modules.toArray()).map((m) => [m.id, m]));
  const weeks = new Map((await db.weeks.toArray()).map((w) => [w.id, w]));
  const sessions = new Map((await db.sessions.toArray()).map((s) => [s.id, s]));
  const links = await db.week_items.toArray();
  const alive = (row: { deleted: boolean } | undefined) => Boolean(row && !row.deleted);
  const weekLabel = (week: WeekRow | undefined) => {
    const module = week ? modules.get(week.module_id) : undefined;
    return week && module ? `${module.code} ${week.term}${week.number}` : "";
  };
  const sessionAlive = (s: SessionRow | undefined) => {
    const week = s ? weeks.get(s.week_id) : undefined;
    return alive(s) && alive(week) && alive(week ? modules.get(week.module_id) : undefined);
  };
  const out: BinEntry[] = [];

  for (const module of recent([...modules.values()])) {
    out.push({
      key: `m:${module.id}`, kind: "module", label: module.code, context: module.title ?? "",
      deletedAt: module.modified_at,
      restore: async () => restoreTree({ table: "modules", row: module }, await moduleTree(module)),
    });
  }

  for (const item of recent(await db.items.toArray())) {
    const own = links.filter((l) => l.item_id === item.id);
    const week = own.map((l) => weeks.get(l.week_id)).find(Boolean);
    const moduleId = week?.module_id ?? item.tray_module_id;
    // Readings taken by a whole module delete come back with the module.
    if (!moduleId || !alive(modules.get(moduleId))) continue;
    const session = own.map((l) => (l.session_id ? sessions.get(l.session_id) : undefined)).find(Boolean);
    if (session && !alive(session) && session.modified_at <= item.modified_at) continue;
    out.push({
      key: `i:${item.id}`, kind: "reading", label: item.title, context: weekLabel(week) || `${modules.get(moduleId)!.code} unsorted`,
      deletedAt: item.modified_at,
      restore: async () => restoreTree({ table: "items", row: item }, await itemTree([item])),
    });
  }

  for (const session of recent([...sessions.values()])) {
    const week = weeks.get(session.week_id);
    if (!alive(week) || !alive(week ? modules.get(week.module_id) : undefined)) continue;
    // An empty session is not worth listing. Marking a reading week clears
    // those, and unmarking it makes fresh ones.
    const tree = await sessionTree([session]);
    if (!tree.some((r) => r.table !== "sessions" && (!r.row.deleted || r.row.modified_at >= session.modified_at))) continue;
    out.push({
      key: `s:${session.id}`, kind: "session",
      label: session.title || (session.kind === "lecture" ? "Lecture" : session.kind === "seminar" ? "Seminar" : "Session"),
      context: weekLabel(week), deletedAt: session.modified_at,
      restore: async () => restoreTree({ table: "sessions", row: session }, await sessionTree([session])),
    });
  }

  for (const question of recent(await db.questions.toArray())) {
    const session = sessions.get(question.session_id);
    if (!sessionAlive(session)) continue;
    out.push({
      key: `q:${question.id}`, kind: "question", label: question.body, context: weekLabel(weeks.get(session!.week_id)),
      deletedAt: question.modified_at,
      restore: async () => restoreTree({ table: "questions", row: question }, await questionTree([question])),
    });
  }

  for (const recording of recent(await db.recordings.toArray())) {
    const session = sessions.get(recording.session_id);
    if (!sessionAlive(session)) continue;
    out.push({
      key: `r:${recording.id}`, kind: "recording",
      label: recording.source === "upload" ? "Uploaded recording" : "Recording",
      context: weekLabel(weeks.get(session!.week_id)), deletedAt: recording.modified_at,
      restore: async () => restoreTree({ table: "recordings", row: recording }, [{ table: "recordings", row: recording }]),
    });
  }

  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

// Weeks and sessions

export async function addSession(week: WeekRow, kind: SessionKind): Promise<void> {
  const existing = (await db.sessions.where("week_id").equals(week.id).toArray()).filter((s) => !s.deleted).sort(byPosition);
  await commit([{
    table: "sessions",
    row: { id: newId(), week_id: week.id, kind, title: null, position: keysAfter(existing.at(-1)?.position ?? null, 1)[0] },
  }]);
}

// Marking a reading week clears its empty sessions and keeps any that hold
// notes, slides or recordings. Unmarking gives the week the module's
// usual sessions if it has none.
export async function setReadingWeek(week: WeekRow, module: ModuleRow, reading: boolean): Promise<{ kept: number }> {
  const sessions = (await db.sessions.where("week_id").equals(week.id).toArray()).filter((s) => !s.deleted).sort(byPosition);
  const changes: Change[] = [{ table: "weeks", row: { ...week, is_reading_week: reading } }];
  let kept = 0;
  if (reading) {
    for (const session of sessions) {
      if (await sessionHasContent(session)) kept += 1;
      else changes.push({ table: "sessions", row: { ...session, deleted: true } });
    }
  } else if (sessions.length === 0) {
    const keys = keysAfter(null, module.session_pattern.length);
    module.session_pattern.forEach((kind, i) => {
      changes.push({ table: "sessions", row: { id: newId(), week_id: week.id, kind, title: null, position: keys[i] } });
    });
  }
  await commit(changes);
  return { kept };
}

// Readings

// Finds which module a reading belongs to, through its week or the tray.
export async function moduleOfItem(item: ItemRow): Promise<string | null> {
  if (item.tray_module_id) return item.tray_module_id;
  const link = (await db.week_items.where("item_id").equals(item.id).toArray()).find((l) => !l.deleted);
  if (!link) return null;
  return (await db.weeks.get(link.week_id))?.module_id ?? null;
}

// Modules

export async function moveModule(id: string, direction: -1 | 1): Promise<void> {
  const modules = (await db.modules.toArray()).filter((m) => !m.deleted).sort(byPosition);
  const index = modules.findIndex((m) => m.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= modules.length) return;
  // Swapping positions keeps every other key as it is.
  const a = modules[index];
  const b = modules[target];
  await commit([
    { table: "modules", row: { id: a.id, position: b.position }, patch: true },
    { table: "modules", row: { id: b.id, position: a.position }, patch: true },
  ]);
}

export async function moveQuestion(question: QuestionRow, direction: -1 | 1): Promise<void> {
  const siblings = (await db.questions.where("session_id").equals(question.session_id).toArray())
    .filter((q) => !q.deleted).sort(byPosition);
  const index = siblings.findIndex((q) => q.id === question.id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= siblings.length) return;
  const other = siblings[target];
  await commit([
    { table: "questions", row: { id: question.id, position: other.position }, patch: true },
    { table: "questions", row: { id: other.id, position: siblings[index].position }, patch: true },
  ]);
}

export async function moveSession(session: SessionRow, direction: -1 | 1): Promise<void> {
  const siblings = (await db.sessions.where("week_id").equals(session.week_id).toArray())
    .filter((s) => !s.deleted).sort(byPosition);
  const index = siblings.findIndex((s) => s.id === session.id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= siblings.length) return;
  const other = siblings[target];
  await commit([
    { table: "sessions", row: { id: session.id, position: other.position }, patch: true },
    { table: "sessions", row: { id: other.id, position: siblings[index].position }, patch: true },
  ]);
}

// Deletes, then offers to undo at the foot of the screen.
export async function withUndo(message: string, run: Promise<Deleted>): Promise<void> {
  const deleted = await run;
  if (!deleted.refs.length) return;
  showToast(message, { label: "Undo", run: () => undo(deleted) });
}

// Deletes a session from wherever it is shown, asking first only if it has
// notes, slides, questions or recordings to lose. Undo is offered either way.
export async function deleteSessionAsking(session: SessionRow, label: string): Promise<boolean> {
  if (await sessionHasContent(session)) {
    const ok = await confirmAction({
      title: `Delete ${label.toLowerCase()}?`,
      body: "Its notes, slides, questions and recordings go with it. Readings in the week stay. You can restore it from Settings for 90 days.",
      confirm: "Delete session",
      danger: true,
    });
    if (!ok) return false;
  }
  await withUndo(`${label} deleted.`, deleteSession(session));
  return true;
}

// Deletes a dissertation section. Its readings are never deleted with it:
// they move to the module's Unsorted. Its own notes and its meetings go with
// it, and Undo brings those back.
export async function deleteSection(week: WeekRow, moduleId: string): Promise<void> {
  const links = (await db.week_items.where("week_id").equals(week.id).toArray()).filter((l) => !l.deleted);
  for (const link of links) {
    const item = await db.items.get(link.item_id);
    if (item && !item.deleted) await moveToTray(item, link, moduleId);
  }
  const sessions = (await db.sessions.where("week_id").equals(week.id).toArray()).filter((s) => !s.deleted);
  const refs: Ref[] = [{ table: "weeks", row: week }, ...(await sessionTree(sessions)), ...(await noteTree("week_id", [week.id]))];
  await withUndo(links.length ? `${weekCode(week)} deleted. Its readings are in Unsorted.` : `${weekCode(week)} deleted.`, softDelete(refs));
}
