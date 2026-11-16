// Writing the calendar's own data. Events and settings go through the same
// insert and update as everything else that syncs, so they reach the outbox
// and the other devices as any edit does. Deleting an event only marks it, as
// every synced row is deleted, so that the deletion syncs too.
//
// insert(table, row) and update(table, id, changes) are the shapes assumed of
// lib/sync, which this file is the only place to call; if they differ, this is
// the one file to change.

import { CALENDAR_SETTINGS_ID, type CalendarSettings, changedColumns, draftColumns, readCalendarSettings, type EventDraft } from "./calendar";
import { db } from "./db";
import { insert, update } from "./sync";
import type { CalendarEventRow } from "./types";

export async function createEvent(draft: EventDraft): Promise<string> {
  const row: CalendarEventRow = {
    id: crypto.randomUUID(),
    modified_at: new Date().toISOString(),
    deleted: false,
    ...draftColumns(draft),
  };
  await insert("calendar_events", row);
  return row.id;
}

// Sends only the columns that changed. Returns false when nothing had.
export async function editEvent(row: CalendarEventRow, draft: EventDraft): Promise<boolean> {
  const changes = changedColumns(row, draft);
  if (Object.keys(changes).length === 0) return false;
  await update("calendar_events", row.id, changes);
  return true;
}

export async function deleteEvent(id: string): Promise<void> {
  await update("calendar_events", id, { deleted: true });
}

// Changes part of the calendar's settings and keeps the rest.
export async function saveCalendarSettings(patch: Partial<CalendarSettings>): Promise<void> {
  const row = await db.settings.get(CALENDAR_SETTINGS_ID);
  const value = { ...readCalendarSettings(row && !row.deleted ? row.value : undefined), ...patch };
  if (row) await update("settings", CALENDAR_SETTINGS_ID, { value, deleted: false });
  else await insert("settings", { id: CALENDAR_SETTINGS_ID, deleted: false, value });
}
