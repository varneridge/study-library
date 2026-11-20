-- To-do lists, in the style of Google Tasks. A list holds tasks, and a task
-- may hold subtasks, one level deep: a subtask names its parent task in
-- parent_id, and a top-level task leaves it empty. due_date is an ISO date
-- (YYYY-MM-DD) and due_time a wall-clock "HH:MM", both optional.

CREATE TABLE task_lists (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  position TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX task_lists_seq ON task_lists (seq);
-- Every synced table numbers its changes, so devices pull them in order.
CREATE TRIGGER task_lists_seq_insert AFTER INSERT ON task_lists
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE task_lists SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE TRIGGER task_lists_seq_update AFTER UPDATE ON task_lists
WHEN NEW.seq = OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE task_lists SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  notes TEXT,
  due_date TEXT,
  due_time TEXT,
  completed_at TEXT,
  position TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX tasks_seq ON tasks (seq);
CREATE TRIGGER tasks_seq_insert AFTER INSERT ON tasks
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE tasks SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE TRIGGER tasks_seq_update AFTER UPDATE ON tasks
WHEN NEW.seq = OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE tasks SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE INDEX tasks_list ON tasks (list_id);
CREATE INDEX tasks_parent ON tasks (parent_id);
