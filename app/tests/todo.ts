// Tests for the to-do lists: ordering, subtasks, completing, undo, dates and
// the tasks route. Everything here is a plain function of rows, so no database
// is needed. Registered from run.ts.

import assert from "node:assert/strict";
import { byPosition } from "../src/lib/keys";
import { href, parseRoute, type Route } from "../src/lib/router";
import {
  arrangeTasks, buildTask, cleanDate, cleanPatch, cleanTime, completionChanges, dueDateOf, liveLists, parentFor, taskFamily, toComplete,
} from "../src/lib/tasks";
import type { TaskListRow, TaskRow } from "../src/lib/types";

export function registerTodoTests(test: (name: string, fn: () => void) => void): void {

const at = "2026-11-20T09:00:00.000Z";
const list = (id: string, position: string, deleted = false): TaskListRow => ({ id, title: id, position, modified_at: at, deleted });
const task = (id: string, extra: Partial<TaskRow> = {}): TaskRow => ({
  id, list_id: "l1", parent_id: null, title: id, notes: null, due_date: null, due_time: null, completed_at: null,
  position: id, modified_at: at, deleted: false, ...extra,
});
const round = (route: Route) => parseRoute(new URL(href(route), "http://localhost").search);

test("lists show in position order and leave out deleted ones", () => {
  const shown = liveLists([list("c", "c"), list("a", "a"), list("b", "b", true)]);
  assert.deepEqual(shown.map((l) => l.id), ["a", "c"]);
});

test("a new task goes after the last sibling, done or not, and a new list's first task starts the order", () => {
  const rows = [task("t1", { position: "a0" }), task("t2", { position: "a1", completed_at: at }), task("gone", { position: "a2", deleted: true })];
  const added = { ...buildTask(rows, { list_id: "l1", title: "Third" }, "t3"), modified_at: at, deleted: false };
  assert.deepEqual([...rows, added].filter((r) => !r.deleted).sort(byPosition).map((r) => r.id), ["t1", "t2", "t3"]);
  assert.equal(added.title, "Third");
  assert.equal(added.parent_id, null);
  assert.equal(added.completed_at, null);
  assert.ok(buildTask([], { list_id: "l1" }, "first").position.length > 0);
  assert.equal(buildTask([], { list_id: "l1" }, "first").title, "");
});

test("tasks in another list do not affect where a task goes", () => {
  const rows = [task("x", { list_id: "l2", position: "zz" })];
  assert.equal(buildTask(rows, { list_id: "l1" }, "t1").position, buildTask([], { list_id: "l1" }, "t1").position);
});

test("a subtask names its parent and orders among that parent's subtasks", () => {
  const rows = [task("p", { position: "a0" }), task("s1", { parent_id: "p", position: "a0" })];
  const added = buildTask(rows, { list_id: "l1", parent_id: "p" }, "s2");
  assert.equal(added.parent_id, "p");
  assert.ok(added.position > "a0");
});

test("subtasks go one level deep, and a bad parent leaves the task at the top", () => {
  const rows = [
    task("p"), task("s", { parent_id: "p" }), task("gone", { deleted: true }), task("other", { list_id: "l2" }),
  ];
  assert.equal(parentFor(rows, "p", "l1"), "p");
  assert.equal(parentFor(rows, "s", "l1"), "p");
  assert.equal(parentFor(rows, "gone", "l1"), null);
  assert.equal(parentFor(rows, "other", "l1"), null);
  assert.equal(parentFor(rows, "missing", "l1"), null);
  assert.equal(parentFor(rows, null, "l1"), null);
  assert.equal(parentFor(rows, undefined, "l1"), null);
});

test("a list's tasks are grouped with their subtasks, without deleted rows or orphans", () => {
  const rows = [
    task("b", { position: "b" }), task("a", { position: "a" }),
    task("a2", { parent_id: "a", position: "b" }), task("a1", { parent_id: "a", position: "a" }),
    task("a3", { parent_id: "a", position: "c", deleted: true }),
    task("orphan", { parent_id: "nowhere" }), task("elsewhere", { list_id: "l2" }),
  ];
  const groups = arrangeTasks(rows, "l1");
  assert.deepEqual(groups.map((g) => g.task.id), ["a", "b"]);
  assert.deepEqual(groups[0].subtasks.map((s) => s.id), ["a1", "a2"]);
  assert.deepEqual(groups[1].subtasks, []);
});

test("completing a task completes its open subtasks and leaves finished ones alone", () => {
  const rows = [task("p"), task("s1", { parent_id: "p" }), task("s2", { parent_id: "p", completed_at: "2026-11-01T08:00:00.000Z" }), task("s3", { parent_id: "p", deleted: true })];
  assert.deepEqual(toComplete(rows[0], rows).map((r) => r.id), ["p", "s1"]);
  assert.deepEqual(toComplete(rows[1], rows).map((r) => r.id), ["s1"]);
});

test("a task that is already done has nothing to complete", () => {
  const done = task("p", { completed_at: at });
  assert.deepEqual(toComplete(done, [done]), []);
});

test("completing and uncompleting are patches of completed_at alone", () => {
  const rows = [task("p"), task("s1", { parent_id: "p" })];
  assert.deepEqual(completionChanges(rows, at), [
    { table: "tasks", row: { id: "p", completed_at: at }, patch: true },
    { table: "tasks", row: { id: "s1", completed_at: at }, patch: true },
  ]);
  assert.deepEqual(completionChanges([rows[0]], null), [{ table: "tasks", row: { id: "p", completed_at: null }, patch: true }]);
});

test("undoing a completion reopens exactly the rows it completed", () => {
  const rows = [task("p"), task("s1", { parent_id: "p" }), task("s2", { parent_id: "p", completed_at: "2026-11-01T08:00:00.000Z" })];
  const changed = toComplete(rows[0], rows);
  const undo = completionChanges(changed, null);
  assert.deepEqual(undo.map((c) => c.row.id), ["p", "s1"]);
  assert.ok(undo.every((c) => c.patch === true && (c.row as { completed_at: null }).completed_at === null));
});

test("uncompleting a parent does not touch its subtasks", () => {
  const rows = [task("p", { completed_at: at }), task("s1", { parent_id: "p", completed_at: at })];
  assert.deepEqual(completionChanges([rows[0]], null).map((c) => c.row.id), ["p"]);
});

test("a delete takes a task with its live subtasks, and a subtask goes alone", () => {
  const rows = [task("p"), task("s1", { parent_id: "p" }), task("s2", { parent_id: "p", deleted: true }), task("q")];
  assert.deepEqual(taskFamily(rows[0], rows).map((r) => r.id), ["p", "s1"]);
  assert.deepEqual(taskFamily(rows[1], rows).map((r) => r.id), ["s1"]);
  assert.deepEqual(taskFamily(rows[3], rows).map((r) => r.id), ["q"]);
});

test("a due date is kept only when it is a real calendar day", () => {
  for (const good of ["2026-11-20", "2028-02-29", "1900-01-01", "2199-12-31"]) assert.equal(cleanDate(good), good);
  for (const bad of ["2026-02-30", "2027-02-29", "2026-13-01", "2026-00-10", "2026-11-00", "16/11/2026", "2026-1-5", "tomorrow", "", " 2026-11-20", "1899-12-31", "2200-01-01"]) {
    assert.equal(cleanDate(bad), null, bad);
  }
  for (const odd of [null, undefined, 20261120, {}, [], true]) assert.equal(cleanDate(odd), null);
});

test("a malformed stored date reads as undated and never throws", () => {
  for (const due_date of ["2026-02-30", "garbage", "", "16/11/2026"]) assert.doesNotThrow(() => assert.equal(dueDateOf({ due_date }), null));
  assert.equal(dueDateOf({ due_date: null }), null);
  assert.equal(dueDateOf({ due_date: "2026-11-20" }), "2026-11-20");
});

test("a due time is kept only as a wall-clock HH:MM", () => {
  for (const good of ["00:00", "09:30", "23:59"]) assert.equal(cleanTime(good), good);
  for (const bad of ["24:00", "9:30", "12:60", "noon", "", "12:30:00", null, undefined, 930]) assert.equal(cleanTime(bad), null, String(bad));
});

test("a new task with a bad date or time is stored undated instead of failing", () => {
  const added = buildTask([], { list_id: "l1", due_date: "2026-02-30", due_time: "99:99" }, "t");
  assert.equal(added.due_date, null);
  assert.equal(added.due_time, null);
  const dated = buildTask([], { list_id: "l1", due_date: "2026-11-20", due_time: "09:30" }, "t");
  assert.equal(dated.due_date, "2026-11-20");
  assert.equal(dated.due_time, "09:30");
});

test("an edit keeps only the columns named, with dates checked, and can clear a date", () => {
  assert.deepEqual(cleanPatch({}), {});
  assert.deepEqual(cleanPatch({ title: "New" }), { title: "New" });
  assert.deepEqual(cleanPatch({ due_date: "2026-02-30" }), { due_date: null });
  assert.deepEqual(cleanPatch({ due_date: null, due_time: null, notes: null }), { due_date: null, due_time: null, notes: null });
  assert.deepEqual(cleanPatch({ due_date: "2026-11-20", due_time: "25:00" }), { due_date: "2026-11-20", due_time: null });
});

test("the tasks route is a stable link and every field survives a round trip", () => {
  assert.equal(href({ view: "tasks" }), "/?v=tasks");
  assert.deepEqual(parseRoute("?v=tasks"), { view: "tasks" });
  const routes: Route[] = [
    { view: "tasks" },
    { view: "tasks", list: "l1" },
    { view: "tasks", task: "t1" },
    { view: "tasks", list: "l1", task: "t1" },
  ];
  for (const route of routes) assert.deepEqual(round(route), route);
  assert.equal(href({ view: "tasks", list: "l1", task: "t:1" }), "/?v=tasks&list=l1&task=t%3A1");
});

test("a parsed tasks route holds only what the link held, and never an id", () => {
  assert.deepEqual(Object.keys(parseRoute("?v=tasks")), ["view"]);
  assert.deepEqual(parseRoute("?v=tasks&list=&task="), { view: "tasks" });
  const withId = parseRoute("?v=tasks&id=m1&list=l1");
  assert.equal("id" in withId, false);
  assert.equal(href(withId), "/?v=tasks&list=l1");
});

test("other fields never leak into a tasks link", () => {
  const route = { view: "tasks", list: "l1", date: "2026-11-20", q: "x", app: "a1" } as unknown as Route;
  assert.equal(href(route), "/?v=tasks&list=l1");
});

}
