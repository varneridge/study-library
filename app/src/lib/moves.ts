// Moving readings between weeks, lists and places in a list. Every move
// can be undone from the notice it leaves, as a delete can.

import { db } from "./db";
import { byPosition, keyBetween, keysAfter } from "./keys";
import { weekCode, titleAfter } from "./modules";
import { commit, newId, type Change } from "./sync";
import type { ItemKind, ItemRow, TableName, Tables, WeekItemRow, WeekRow } from "./types";
import { showToast } from "./ui";

type Row = Tables[TableName];

// Puts back the rows a move changed, as they were before it.
async function undoable(message: string, before: { table: TableName; row: Row }[], changes: Change[]): Promise<void> {
  await commit(changes);
  showToast(message, {
    label: "Undo",
    run: async () => {
      // Only the fields the move changed are put back, so an edit made since
      // to anything else on the row stays.
      const restore: Change[] = [];
      for (const { table, row } of before) {
        const moved = changes.find((c) => c.table === table && c.row.id === row.id);
        const fields = moved ? Object.keys(moved.row) : Object.keys(row);
        const back = Object.fromEntries(fields.map((f) => [f, (row as unknown as Record<string, unknown>)[f] ?? null]));
        restore.push({ table, row: { ...back, id: row.id }, patch: true } as Change);
      }
      // A link the move created is removed again.
      for (const change of changes) {
        if (change.table === "week_items" && !before.some((b) => b.row.id === change.row.id)) {
          const current = await db.week_items.get(change.row.id);
          if (current) restore.push({ table: "week_items", row: { id: current.id, deleted: true }, patch: true });
        }
      }
      await commit(restore);
    },
  });
}

async function linksIn(weekId: string, sessionId: string | null): Promise<WeekItemRow[]> {
  return (await db.week_items.where("week_id").equals(weekId).toArray())
    .filter((l) => !l.deleted && (l.session_id ?? null) === sessionId)
    .sort(byPosition);
}

// The session slides go to when they land in a week.
async function slideSession(weekId: string): Promise<string | null> {
  const sessions = (await db.sessions.where("week_id").equals(weekId).toArray()).filter((s) => !s.deleted).sort(byPosition);
  return (sessions.find((s) => s.kind !== "seminar") ?? sessions[0])?.id ?? null;
}

// Moves a reading to the end of another week, in this module or another.
// Its highlights and notes belong to the reading, so they go with it.
export async function moveToWeek(item: ItemRow, link: WeekItemRow | null, week: WeekRow): Promise<void> {
  if (link?.week_id === week.id) return;
  const sessionId = item.kind === "slides" ? await slideSession(week.id) : null;
  const position = keysAfter((await linksIn(week.id, sessionId)).at(-1)?.position ?? null, 1)[0];
  const before = [{ table: "items" as const, row: item }, ...(link ? [{ table: "week_items" as const, row: link }] : [])];
  const module = await db.modules.get(week.module_id);
  const from = link ? (await db.weeks.get(link.week_id))?.module_id : item.tray_module_id;
  const where = `${from && from !== week.module_id && module ? `${module.code} ` : ""}${weekCode(week)}${titleAfter(week, ", ")}`;
  await undoable(`Moved to ${where}.`, before, [
    ...(link ? [{ table: "week_items" as const, row: { id: link.id, deleted: true }, patch: true as const }] : []),
    { table: "week_items", row: { id: newId(), week_id: week.id, item_id: item.id, session_id: sessionId, position } },
    { table: "items", row: { id: item.id, tray_module_id: null }, patch: true },
  ]);
}

// Places a reading among others in the same week: before a given reading,
// or at the end of a list. Crossing between readings and primary sources
// changes what kind of item it is.
export async function placeInWeek(
  item: ItemRow,
  link: WeekItemRow,
  order: { id: string; position: string }[],
  index: number,
  kind: ItemKind,
): Promise<void> {
  const others = order.filter((o) => o.id !== link.id);
  const at = Math.max(0, Math.min(index, others.length));
  const position = keyBetween(others[at - 1]?.position ?? null, others[at]?.position ?? null);
  const changes: Change[] = [{ table: "week_items", row: { id: link.id, position }, patch: true }];
  if (kind !== item.kind) changes.push({ table: "items", row: { id: item.id, kind }, patch: true });
  if (kind === item.kind) {
    // A plain reorder needs no notice: the list shows the result.
    await commit(changes);
    return;
  }
  await undoable(
    kind === "primary" ? "Now a primary source." : "Now a reading.",
    [{ table: "items", row: item }, { table: "week_items", row: link }],
    changes,
  );
}

// Takes a reading out of its week and into a module's unsorted tray. The
// module can be another one, which is how a reading changes module.
export async function moveToTray(item: ItemRow, link: WeekItemRow | null, moduleId: string, message = "Moved to Unsorted."): Promise<void> {
  if (!link && item.tray_module_id === moduleId) return;
  await undoable(message, [{ table: "items", row: item }, ...(link ? [{ table: "week_items" as const, row: link }] : [])], [
    ...(link ? [{ table: "week_items" as const, row: { id: link.id, deleted: true }, patch: true as const }] : []),
    { table: "items", row: { id: item.id, tray_module_id: moduleId }, patch: true },
  ]);
}

// Places slides among a session's other slides, in the same session or
// another one in the week. A plain reorder needs no notice.
export async function placeSlides(
  item: ItemRow,
  link: WeekItemRow,
  order: { id: string; position: string }[],
  index: number,
  sessionId: string,
  sessionName: string,
): Promise<void> {
  const others = order.filter((o) => o.id !== link.id);
  const at = Math.max(0, Math.min(index, others.length));
  const position = keyBetween(others[at - 1]?.position ?? null, others[at]?.position ?? null);
  const changes: Change[] = [{ table: "week_items", row: { id: link.id, position, session_id: sessionId }, patch: true }];
  if (link.session_id === sessionId) {
    await commit(changes);
    return;
  }
  await undoable(`Slides moved to the ${sessionName}.`, [{ table: "week_items", row: link }], changes);
}

export function positionsOf(links: (WeekItemRow | null)[]): { id: string; position: string }[] {
  return links.filter((l): l is WeekItemRow => Boolean(l)).map((l) => ({ id: l.id, position: l.position }));
}

// Moves a reading one place up or down among its neighbours: the week's
// readings, its primary sources, or a session's slides. On a touch screen
// this stands in for dragging. Returns false at the top or the foot.
export async function nudge(item: ItemRow, link: WeekItemRow, direction: -1 | 1): Promise<boolean> {
  const links = (await db.week_items.where("week_id").equals(link.week_id).toArray())
    .filter((l) => !l.deleted && (l.session_id ?? null) === (link.session_id ?? null));
  const items = new Map((await db.items.bulkGet(links.map((l) => l.item_id))).filter((i): i is ItemRow => Boolean(i)).map((i) => [i.id, i]));
  const group = (i: ItemRow | undefined) => (i?.kind === "primary" ? "primary" : "readings");
  const mine = group(item);
  const siblings = links.filter((l) => !items.get(l.item_id)?.deleted && group(items.get(l.item_id)) === mine).sort(byPosition);
  const index = siblings.findIndex((l) => l.id === link.id);
  const other = siblings[index + direction];
  if (index < 0 || !other) return false;
  await commit([
    { table: "week_items", row: { id: link.id, position: other.position }, patch: true },
    { table: "week_items", row: { id: other.id, position: link.position }, patch: true },
  ]);
  return true;
}
