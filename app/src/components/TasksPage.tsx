// The to-do lists, in the style of Google Tasks: the lists beside the tasks on
// a laptop, a list switcher on a phone. A task opens in a sheet, whose address
// carries the task, so a link from the calendar lands on it and Back closes it.
// Adding, finishing, moving and deleting go through lib/tasks, which offers
// Undo wherever something is taken away.

import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "../App";
import { type ISODate, parseISO } from "../lib/civilDate";
import { shortDate } from "../lib/dates";
import { db, getMeta } from "../lib/db";
import { useUnsavedChangesGuard } from "../lib/formDraft";
import { navigate, type Route } from "../lib/router";
import {
  arrangeTasks, cleanTime, clearCompleted, createList, createTask, deleteList, deleteTask, dueDateOf, liveLists,
  neighbourOf, renameList, reorderTask, toggleTask, updateTask,
} from "../lib/tasks";
import type { TaskListRow, TaskRow } from "../lib/types";
import { showToast } from "../lib/ui";
import { Sheet } from "./calendar/Sheet";
import { usePhone } from "./calendar/hooks";
import { ChoiceCard } from "./ChoiceCard";
import { DatePicker } from "./DatePicker";
import { Icon } from "./icons";
import { Menu } from "./Menu";
import "./TasksPage.css";

type TasksRoute = Extract<Route, { view: "tasks" }>;

const DEFAULT_LIST = "My tasks";
const nameOf = (task: TaskRow) => task.title.trim() || "Untitled task";
const firstLine = (text: string) => text.trim().split("\n")[0];

// "12 Oct", "12 Oct 2027" in another year, and "12 Oct, 14:30" with a time.
function dueText(task: TaskRow): string | null {
  const iso = dueDateOf(task);
  const parts = iso ? parseISO(iso) : null;
  if (!parts) return null;
  const day = shortDate(new Date(parts.year, parts.month - 1, parts.day), { year: parts.year !== new Date().getFullYear() });
  const time = cleanTime(task.due_time);
  return time ? `${day}, ${time}` : day;
}

// A name for a list, to add one or to rename one. Enter saves and Escape
// leaves it as it was, and the button waits from the first press until the
// list is saved, so a double tap makes one list.
function ListForm({ initial, label, onSave, onCancel }: {
  initial: string; label: string; onSave: (title: string) => Promise<void>; onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const submit = async () => {
    const clean = title.trim();
    if (!clean || busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      await onSave(clean);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  return (
    <form
      className="tasks-list-form"
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}
    >
      <input type="text" autoFocus autoComplete="off" aria-label="List name" value={title} onChange={(e) => setTitle(e.target.value)} />
      <div className="tasks-buttons">
        <button type="submit" className="button" disabled={saving || !title.trim()}>{label}</button>
        <button type="button" className="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// The quick-add form at the top of the list. A title is enough. Details add a
// due date and notes, and a subtask names its parent. Cancel appears once
// there is something to put away.
function AddTask({ list, parent, onClearParent, inputRef }: {
  list: TaskListRow; parent: TaskRow | null; onClearParent: () => void; inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState<ISODate | null>(null);
  const [details, setDetails] = useState(false);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const dirty = Boolean(title || notes || date || parent) || details;

  const cancel = () => {
    setTitle("");
    setNotes("");
    setDate(null);
    setDetails(false);
    onClearParent();
  };
  const submit = async () => {
    const clean = title.trim();
    if (!clean || busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      const id = await createTask({ list_id: list.id, title: clean, notes: notes.trim() || null, due_date: date, parent_id: parent?.id });
      setTitle("");
      setNotes("");
      setDate(null);
      showToast(parent ? "Subtask added." : "Task added.", {
        label: "Undo",
        run: async () => {
          const row = await db.tasks.get(id);
          if (row) await deleteTask(row);
        },
      });
      inputRef.current?.focus();
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return (
    <form
      className="tasks-add"
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      onKeyDown={(e) => { if (e.key === "Escape" && dirty) { e.stopPropagation(); cancel(); } }}
    >
      {parent && <p className="tasks-chip">Subtask of {nameOf(parent)}</p>}
      <div className="tasks-add-row">
        <input
          ref={inputRef}
          type="text"
          autoComplete="off"
          aria-label={parent ? "Subtask title" : "Task title"}
          placeholder={parent ? "Add a subtask" : "Add a task"}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button type="submit" className="button primary" disabled={saving || !title.trim()}>{parent ? "Add subtask" : "Add task"}</button>
      </div>
      {details && (
        <div className="tasks-add-details">
          <DatePicker label="Due date" value={date} onChange={setDate} clearable placeholder="Due date" />
          <textarea aria-label="Notes" placeholder="Notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      )}
      <div className="tasks-buttons">
        <button type="button" className="quiet" aria-expanded={details} onClick={() => setDetails((v) => !v)}>
          {details ? "Hide details" : "Add details"}
        </button>
        {dirty && <button type="button" className="button" onClick={cancel}>Cancel</button>}
      </div>
    </form>
  );
}

// One task: a tick to finish it, its title and when it is due, which open it,
// and a menu for the rest. Its subtasks, if any, are the children.
function TaskItem({ task, rows, onOpen, onAddSubtask, children }: {
  task: TaskRow; rows: TaskRow[]; onOpen: (task: TaskRow) => void; onAddSubtask: (task: TaskRow) => void; children?: ReactNode;
}) {
  const done = Boolean(task.completed_at);
  const title = nameOf(task);
  const meta = [dueText(task), task.notes?.trim() ? firstLine(task.notes) : null].filter(Boolean).join(", ");
  return (
    <li className="tasks-entry">
      <div className={`tasks-item${done ? " is-done" : ""}`}>
        <label className="tasks-check">
          <input type="checkbox" checked={done} aria-label={`${title}, done`} onChange={() => void toggleTask(task)} />
        </label>
        <button type="button" className="tasks-open" onClick={() => onOpen(task)}>
          <span className="tasks-title">{title}</span>
          {meta && <span className="tasks-meta">{meta}</span>}
        </button>
        <Menu
          label={`Actions for ${title}`}
          items={[
            { label: "Edit task", onSelect: () => onOpen(task) },
            { label: "Add subtask", hidden: Boolean(task.parent_id) || done, onSelect: () => onAddSubtask(task) },
            { label: "Move up", hidden: !neighbourOf(rows, task, -1), onSelect: () => void reorderTask(task, -1) },
            { label: "Move down", hidden: !neighbourOf(rows, task, 1), onSelect: () => void reorderTask(task, 1) },
            { label: "Delete task", danger: true, onSelect: () => void deleteTask(task) },
          ]}
        />
      </div>
      {children}
    </li>
  );
}

// The sheet for one task. Cancel, Escape and a tap outside leave it as it was,
// and leaving with edits not yet saved asks first.
function TaskForm({ row, onClose }: { row: TaskRow; onClose: () => void }) {
  const phone = usePhone();
  const formId = useId();
  const [title, setTitle] = useState(row.title);
  const [notes, setNotes] = useState(row.notes ?? "");
  const [date, setDate] = useState<ISODate | null>(dueDateOf(row));
  const [time, setTime] = useState(cleanTime(row.due_time) ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"title" | "save" | null>(null);
  const busy = useRef(false);
  const dirty = title !== row.title
    || notes !== (row.notes ?? "")
    || date !== dueDateOf(row)
    || (date ? time : "") !== (cleanTime(row.due_time) ?? "");
  const { disarm } = useUnsavedChangesGuard(dirty, "task");

  const finish = async (run: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      await run();
      disarm();
      onClose();
    } catch {
      setError("save");
      busy.current = false;
      setSaving(false);
    }
  };
  const save = () => {
    if (!title.trim()) {
      setError("title");
      return;
    }
    void finish(() => updateTask(row, { title: title.trim(), notes: notes.trim() || null, due_date: date, due_time: date && time ? time : null }));
  };

  return (
    <Sheet
      title="Edit task"
      onClose={onClose}
      foot={(
        <>
          <button type="button" className="button danger cal-delete" disabled={saving} onClick={() => void finish(() => deleteTask(row))}>Delete task</button>
          <span className="spacer" />
          <button type="button" className="button" disabled={saving} onClick={onClose}>Cancel</button>
          <button type="submit" form={formId} className="button primary" disabled={saving}>Save</button>
        </>
      )}
    >
      <form id={formId} className="cal-form" noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label className="cal-field">
          <span>Title</span>
          <input
            type="text"
            className="cal-input"
            value={title}
            autoFocus={!phone}
            aria-invalid={error === "title" || undefined}
            onChange={(e) => { setTitle(e.target.value); setError(null); }}
          />
          {error === "title" && <span className="cal-error" role="alert">Give the task a title.</span>}
        </label>
        <div className="cal-field" role="group" aria-label="Due">
          <span aria-hidden="true">Due</span>
          <div className="cal-when">
            <DatePicker label="Due date" value={date} onChange={setDate} clearable placeholder="No due date" />
            {date && <input type="time" step={900} className="cal-input cal-time" aria-label="Due time" value={time} onChange={(e) => setTime(e.target.value)} />}
          </div>
        </div>
        <label className="cal-field">
          <span>Notes</span>
          <textarea className="cal-input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {error === "save" && <p className="cal-error" role="alert">This could not be saved. Try again.</p>}
      </form>
    </Sheet>
  );
}

function TaskSheet({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const row = useLiveQuery(async () => (await db.tasks.get(taskId)) ?? null, [taskId]);
  if (row === undefined) return null;
  if (!row || row.deleted) {
    return (
      <Sheet title="Task not found" onClose={onClose} foot={<button type="button" className="button" onClick={onClose}>Close</button>}>
        <p className="muted">This task has been deleted, or the link is not to one of yours.</p>
      </Sheet>
    );
  }
  return <TaskForm key={row.id} row={row} onClose={onClose} />;
}

export function TasksPage({ route }: { route: TasksRoute }) {
  const phone = usePhone();
  const lists = useLiveQuery(async () => liveLists(await db.task_lists.toArray()), []);
  const active = lists?.find((l) => l.id === route.list) ?? lists?.[0];
  const rows = useLiveQuery(async () => (active ? await db.tasks.where("list_id").equals(active.id).toArray() : []), [active?.id]);
  const [editing, setEditing] = useState<"add" | "rename" | null>(null);
  const [switching, setSwitching] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [parent, setParent] = useState<TaskRow | null>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const switchRef = useRef<HTMLButtonElement>(null);
  // Whether the open sheet was pushed on by this page, so that closing it can step back.
  const pushed = useRef(false);
  const seeded = useRef(false);

  useEffect(() => {
    if (!route.task) pushed.current = false;
  }, [route.task]);
  // Another list starts with no subtask chosen and no list form open.
  useEffect(() => {
    setParent(null);
    setEditing(null);
  }, [active?.id]);
  // A first visit finds a list ready. It waits for the first pull, so a new
  // device judges what the server holds rather than an empty database.
  useEffect(() => {
    if (!lists || lists.length || seeded.current) return;
    seeded.current = true;
    void getMeta<number>("cursor").then((cursor) => (cursor ? createList(DEFAULT_LIST) : undefined));
  }, [lists]);

  if (!lists) return <section className="page wide tasks-page" aria-label="To do" />;

  const addList = async (title: string) => {
    const id = await createList(title);
    setEditing(null);
    showToast("List added.");
    void navigate({ view: "tasks", list: id });
  };
  const addForm = editing === "add" && <ListForm initial="" label="Add list" onSave={addList} onCancel={() => setEditing(null)} />;

  if (!active) {
    return (
      <section className="page wide tasks-page" aria-label="To do">
        <div className="section-head"><h1>To do</h1></div>
        <p className="muted">You have no lists yet. Add one to start.</p>
        {addForm || <button type="button" className="button" onClick={() => setEditing("add")}>Add a list</button>}
      </section>
    );
  }

  const all = rows ?? [];
  const groups = arrangeTasks(all, active.id);
  const open = groups.filter((g) => !g.task.completed_at);
  const done = groups.filter((g) => g.task.completed_at);
  const isDefault = active.id === lists[0].id;

  const openTask = (task: TaskRow) => {
    pushed.current = true;
    void navigate({ view: "tasks", list: active.id, task: task.id });
  };
  const closeSheet = () => {
    if (pushed.current) history.back();
    else void navigate({ view: "tasks", list: route.list }, { replace: true });
  };
  const addSubtask = (task: TaskRow) => {
    setParent(task);
    requestAnimationFrame(() => addRef.current?.focus());
  };
  const rename = async (title: string) => {
    await renameList(active, title);
    setEditing(null);
    showToast("List renamed.");
  };
  const removeList = async () => {
    await deleteList(active);
    void navigate({ view: "tasks" }, true);
  };

  const item = (group: { task: TaskRow; subtasks: TaskRow[] }) => (
    <TaskItem key={group.task.id} task={group.task} rows={all} onOpen={openTask} onAddSubtask={addSubtask}>
      {group.subtasks.length > 0 && (
        <ul className="tasks-sub">
          {group.subtasks.map((sub) => <TaskItem key={sub.id} task={sub} rows={all} onOpen={openTask} onAddSubtask={addSubtask} />)}
        </ul>
      )}
    </TaskItem>
  );

  return (
    <section className="page wide tasks-page" aria-label="To do">
      <div className={`tasks-layout${phone ? " is-solo" : ""}`}>
        {!phone && (
          <aside className="tasks-lists" aria-label="Lists">
            <nav aria-label="Lists">
              {lists.map((list) => (
                <Link key={list.id} to={{ view: "tasks", list: list.id }} className="tasks-list-link" current={list.id === active.id}>{list.title}</Link>
              ))}
            </nav>
            {addForm || (
              <button type="button" className="quiet tasks-list-add" onClick={() => setEditing("add")}>
                <Icon name="add" size={16} /> Add list
              </button>
            )}
          </aside>
        )}
        <div className="tasks-main">
          {phone && addForm}
          <div className="section-head tasks-head">
            {editing === "rename"
              ? <ListForm initial={active.title} label="Save list" onSave={rename} onCancel={() => setEditing(null)} />
              : <h1>{active.title}</h1>}
            <span className="spacer" />
            {editing !== "rename" && (
              <Menu
                label="List actions"
                items={[
                  { label: "Rename list", onSelect: () => setEditing("rename") },
                  { label: "Delete list", danger: true, hidden: isDefault, onSelect: () => void removeList() },
                ]}
              />
            )}
          </div>
          {phone && (
            <button ref={switchRef} type="button" className="button tasks-switch" aria-haspopup="dialog" onClick={() => setSwitching(true)}>
              Lists <Icon name="down" size={14} />
            </button>
          )}
          <AddTask key={active.id} list={active} parent={parent} onClearParent={() => setParent(null)} inputRef={addRef} />
          {open.length === 0 && done.length === 0 && <p className="muted">Nothing to do here yet. Add a task above.</p>}
          {open.length > 0 && <ul className="tasks-list">{open.map(item)}</ul>}
          {done.length > 0 && (
            <section className="tasks-completed" aria-label="Completed tasks">
              <div className="tasks-completed-head">
                <button type="button" className="quiet" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                  <span className={`tasks-caret${showDone ? " is-open" : ""}`} aria-hidden="true"><Icon name="down" size={14} /></span>
                  Completed ({done.length})
                </button>
                <button type="button" className="quiet danger" onClick={() => void clearCompleted(active.id)}>Clear completed</button>
              </div>
              {showDone && <ul className="tasks-list">{done.map(item)}</ul>}
            </section>
          )}
        </div>
      </div>

      <ChoiceCard
        open={switching}
        onClose={() => setSwitching(false)}
        anchor={switchRef}
        label="Lists"
        title={<h2 className="choice-title">Lists</h2>}
        initialFocus="[aria-pressed='true']"
      >
        <div className="tasks-choices" role="group" aria-label="Lists">
          {lists.map((list) => (
            <button
              key={list.id}
              type="button"
              className="tasks-choice"
              aria-pressed={list.id === active.id}
              onClick={() => {
                setSwitching(false);
                void navigate({ view: "tasks", list: list.id });
              }}
            >
              <span>{list.title}</span>
              {list.id === active.id && <Icon name="check" size={14} />}
            </button>
          ))}
          <button type="button" className="tasks-choice" onClick={() => { setSwitching(false); setEditing("add"); }}>
            <span>Add a list</span><Icon name="add" size={14} />
          </button>
        </div>
      </ChoiceCard>
      {route.task && <TaskSheet taskId={route.task} onClose={closeSheet} />}
    </section>
  );
}
