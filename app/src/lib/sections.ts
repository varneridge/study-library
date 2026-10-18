// Dissertation modules: sections you name and order, in place of weeks of
// term. A section is a week whose term is "S" and whose number is its place.

import { db } from "./db";
import { byPosition, keysAfter } from "./keys";
import { byWeek, weekCode } from "./modules";
import { commit, newId, type Change } from "./sync";
import type { KeyDate, ModuleRow, WeekRow } from "./types";
import { showToast } from "./ui";

export const isDissertation = (module: Pick<ModuleRow, "kind"> | null | undefined) => module?.kind === "dissertation";

async function sectionsOf(moduleId: string): Promise<WeekRow[]> {
  return (await db.weeks.where("module_id").equals(moduleId).toArray()).filter((w) => !w.deleted && w.term === "S").sort(byWeek);
}

// A new section at the foot of the list. Returns its id.
export async function addSection(moduleId: string, title: string | null = null): Promise<string> {
  const sections = await sectionsOf(moduleId);
  const id = newId();
  const number = (sections[sections.length - 1]?.number ?? 0) + 1;
  await commit([{ table: "weeks", row: { id, module_id: moduleId, term: "S" as const, number, title: title?.trim() || null, is_reading_week: false } }]);
  return id;
}

// Moves a section one place up or down. Returns false at either end.
export async function moveSection(week: WeekRow, direction: -1 | 1): Promise<boolean> {
  const sections = await sectionsOf(week.module_id);
  const at = sections.findIndex((s) => s.id === week.id);
  const other = sections[at + direction];
  if (at < 0 || !other) return false;
  await commit([
    { table: "weeks", row: { id: week.id, number: other.number }, patch: true },
    { table: "weeks", row: { id: other.id, number: week.number }, patch: true },
  ]);
  return true;
}

// Adds a supervision meeting to a section, named for the day. Returns its id.
export async function addMeeting(weekId: string): Promise<string> {
  const sessions = (await db.sessions.where("week_id").equals(weekId).toArray()).filter((s) => !s.deleted).sort(byPosition);
  const id = newId();
  const day = new Date();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  await commit([{
    table: "sessions",
    row: { id, week_id: weekId, kind: "supervision" as const, title: `Supervision, ${day.getDate()} ${months[day.getMonth()]}`, position: keysAfter(sessions[sessions.length - 1]?.position ?? null, 1)[0] },
  }]);
  return id;
}

// Key dates: kept on the module, in date order.
export async function saveKeyDates(module: ModuleRow, dates: KeyDate[]): Promise<void> {
  const sorted = [...dates].sort((a, b) => a.date.localeCompare(b.date));
  await commit([{ table: "modules", row: { id: module.id, key_dates: sorted }, patch: true }]);
}

// Turns a taught module into a dissertation. Every week with something in it
// becomes a section named after it, in term order, to be renamed or merged;
// empty weeks are deleted.
export async function convertToDissertation(module: ModuleRow): Promise<number> {
  const weeks = (await db.weeks.where("module_id").equals(module.id).toArray()).filter((w) => !w.deleted && w.term !== "S").sort(byWeek);
  const changes: Change[] = [{ table: "modules", row: { id: module.id, kind: "dissertation", key_dates: module.key_dates ?? [] }, patch: true }];
  let number = 0;
  for (const week of weeks) {
    const links = (await db.week_items.where("week_id").equals(week.id).toArray()).filter((l) => !l.deleted);
    const sessions = (await db.sessions.where("week_id").equals(week.id).toArray()).filter((s) => !s.deleted);
    const notes = sessions.length ? (await db.notes.where("session_id").anyOf(sessions.map((s) => s.id)).toArray()).filter((n) => !n.deleted) : [];
    const recordings = sessions.length ? (await db.recordings.where("session_id").anyOf(sessions.map((s) => s.id)).toArray()).filter((r) => !r.deleted) : [];
    const questions = sessions.length ? (await db.questions.where("session_id").anyOf(sessions.map((s) => s.id)).toArray()).filter((q) => !q.deleted) : [];
    if (links.length || notes.length || recordings.length || questions.length) {
      number += 1;
      changes.push({ table: "weeks", row: { id: week.id, term: "S" as const, number, title: week.title ? `${weekCode(week)}, ${week.title}` : weekCode(week) }, patch: true });
      // Sessions with nothing in them go; the rest stay, with their notes.
      for (const s of sessions) {
        const used = notes.some((n) => n.session_id === s.id) || recordings.some((r) => r.session_id === s.id) || questions.some((q) => q.session_id === s.id);
        if (!used) changes.push({ table: "sessions", row: { id: s.id, deleted: true }, patch: true });
      }
    } else {
      changes.push({ table: "weeks", row: { id: week.id, deleted: true }, patch: true });
      for (const s of sessions) changes.push({ table: "sessions", row: { id: s.id, deleted: true }, patch: true });
    }
  }
  if (!number) {
    changes.push({ table: "weeks", row: { id: newId(), module_id: module.id, term: "S" as const, number: 1, title: null, is_reading_week: false } });
  }
  await commit(changes);
  showToast(number ? `Now a dissertation, with ${number} ${number === 1 ? "section" : "sections"} from its weeks.` : "Now a dissertation, with one section to start.");
  return number;
}

// How far off a date is, in words, as the job search says it: "in 9 days",
// "tomorrow", "today", "3 days ago". Soon is a week or less.
export function countdown(iso: string, now = new Date()): { words: string; state: "past" | "today" | "soon" | "later"; days: number } {
  const day = new Date(`${iso}T00:00:00`);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((day.getTime() - today.getTime()) / 86400000);
  if (days < 0) return { words: days === -1 ? "yesterday" : `${-days} days ago`, state: "past", days };
  if (days === 0) return { words: "today", state: "today", days };
  if (days === 1) return { words: "tomorrow", state: "soon", days };
  return { words: `in ${days} days`, state: days <= 7 ? "soon" : "later", days };
}
