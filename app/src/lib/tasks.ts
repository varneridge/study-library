// To-do lists in the style of Google Tasks: lists of tasks, each task with
// optional subtasks one level deep. Completing and deleting offer Undo.
//
// The ordering, validation and change-building below are plain functions of
// rows, so the tests can run them without a database. The actions at the
// foot read the rows and commit what those functions work out.

import { parseISO } from "./civilDate";
import { db } from "./db";
import { deleteRows, withUndo } from "./edits";
import { byPosition, keysAfter } from "./keys";
import { commit, newId, type Change } from "./sync";
import { showToast } from "./ui";
import type { TaskListRow, TaskRow } from "./types";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// A due date is kept only when it is a real calendar day. Anything else,
// such as 2026-02-30 or free text from an older device, counts as undated
// and never throws.
export function cleanDate(value: unknown): string | null {
  return typeof value === "string" && parseISO(value) ? value : null;
}

export function cleanTime(value: unknown): string | null {
  return typeof value === "string" && TIME_RE.test(value) ? value : null;
}

export const dueDateOf = (task: Pick<TaskRow, "due_date">): string | null => cleanDate(task.due_date);

export const liveLists = (lists: TaskListRow[]): TaskListRow[] => lists.filter((l) => !l.deleted).sort(byPosition);

export interface TaskGroup { task: TaskRow; subtasks: TaskRow[] }

// One list's tasks in order, each with its subtasks. A subtask whose parent
// is missing or deleted is not shown.
export function arrangeTasks(rows: TaskRow[], listId: string): TaskGroup[] {
  const live = rows.filter((r) => !r.deleted && r.list_id === listId).sort(byPosition);
  return live.filter((r) => !r.parent_id).map((task) => ({ task, subtasks: live.filter((r) => r.parent_id === task.id) }));
}

// Subtasks go one level deep. Asking to nest under a subtask nests under its
// parent instead, and a parent that is missing, deleted or in another list
// leaves the task at the top level.
export function parentFor(rows: TaskRow[], parentId: string | null | undefined, listId: string): string | null {
  if (!parentId) return null;
  const parent = rows.find((r) => r.id === parentId && !r.deleted && r.list_id === listId);
  return parent ? parent.parent_id ?? parent.id : null;
}

export interface NewTask {
  list_id: string;
  title?: string;
  notes?: string | null;
  due_date?: string | null;
  due_time?: string | null;
  parent_id?: string | null;
}

// A new task goes after its siblings, whether they are done or not.
export function buildTask(rows: TaskRow[], input: NewTask, id: string): Omit<TaskRow, "modified_at" | "seq" | "deleted"> {
  const parent_id = parentFor(rows, input.parent_id, input.list_id);
  const siblings = rows
    .filter((r) => !r.deleted && r.list_id === input.list_id && (r.parent_id ?? null) === parent_id)
    .sort(byPosition);
  return {
    id,
    list_id: input.list_id,
    parent_id,
    title: input.title ?? "",
    notes: input.notes ?? null,
    due_date: cleanDate(input.due_date),
    due_time: cleanTime(input.due_time),
    completed_at: null,
    position: keysAfter(siblings.at(-1)?.position ?? null, 1)[0],
  };
}

export type TaskPatch = Partial<Pick<TaskRow, "title" | "notes" | "due_date" | "due_time">>;

// Only the columns named are kept, with dates and times checked.
export function cleanPatch(patch: TaskPatch): TaskPatch {
  const out: TaskPatch = {};
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.notes !== undefined) out.notes = patch.notes;
  if (patch.due_date !== undefined) out.due_date = cleanDate(patch.due_date);
  if (patch.due_time !== undefined) out.due_time = cleanTime(patch.due_time);
  return out;
}

// A task and the live subtasks that go with it, which is what a delete takes.
export function taskFamily(task: TaskRow, rows: TaskRow[]): TaskRow[] {
  if (task.parent_id) return [task];
  return [task, ...rows.filter((r) => !r.deleted && r.parent_id === task.id)];
}

// What completing a task changes: the task and any subtasks still open, but
// nothing when the task is already done.
export function toComplete(task: TaskRow, rows: TaskRow[]): TaskRow[] {
  if (task.completed_at) return [];
  return taskFamily(task, rows).filter((r) => !r.completed_at);
}

export function completionChanges(rows: TaskRow[], completedAt: string | null): Change[] {
  return rows.map((r) => ({ table: "tasks" as const, row: { id: r.id, completed_at: completedAt }, patch: true }));
}

// Actions

const undoable = (message: string, run: () => Promise<unknown>) =>
  showToast(message, { label: "Undo", run: async () => void (await run()) });

export async function createList(title: string): Promise<string> {
  const lists = liveLists(await db.task_lists.toArray());
  const id = newId();
  await commit([{ table: "task_lists", row: { id, title: title.trim(), position: keysAfter(lists.at(-1)?.position ?? null, 1)[0] } }]);
  return id;
}

export async function renameList(list: TaskListRow, title: string): Promise<void> {
  await commit([{ table: "task_lists", row: { id: list.id, title: title.trim() }, patch: true }]);
}

// A list goes with its tasks, and Undo brings them all back.
export async function deleteList(list: TaskListRow): Promise<void> {
  const tasks = (await db.tasks.where("list_id").equals(list.id).toArray()).filter((t) => !t.deleted);
  await withUndo(
    "List deleted.",
    deleteRows([{ table: "task_lists", row: list }, ...tasks.map((row) => ({ table: "tasks" as const, row }))]),
  );
}

export async function createTask(input: NewTask): Promise<string> {
  const rows = await db.tasks.where("list_id").equals(input.list_id).toArray();
  const id = newId();
  await commit([{ table: "tasks", row: buildTask(rows, input, id) }]);
  return id;
}

export async function updateTask(task: TaskRow, patch: TaskPatch): Promise<void> {
  const clean = cleanPatch(patch);
  if (!Object.keys(clean).length) return;
  await commit([{ table: "tasks", row: { id: task.id, ...clean }, patch: true }]);
}

// Completing a task completes its open subtasks too. Undo reopens exactly
// those that this completed, so a subtask finished earlier stays finished.
export async function completeTask(task: TaskRow): Promise<void> {
  const changed = toComplete(task, await db.tasks.where("list_id").equals(task.list_id).toArray());
  if (!changed.length) return;
  await commit(completionChanges(changed, new Date().toISOString()));
  undoable("Task completed.", () => commit(completionChanges(changed, null)));
}

export async function uncompleteTask(task: TaskRow): Promise<void> {
  if (!task.completed_at) return;
  const was = task.completed_at;
  await commit(completionChanges([task], null));
  undoable("Task marked as not done.", () => commit(completionChanges([task], was)));
}

// A task goes with its subtasks, and Undo brings them back.
export async function deleteTask(task: TaskRow): Promise<void> {
  const family = taskFamily(task, await db.tasks.where("list_id").equals(task.list_id).toArray());
  await withUndo("Task deleted.", deleteRows(family.map((row) => ({ table: "tasks" as const, row }))));
}
