-- Dissertation modules. A dissertation is organised by sections you name
-- and order, not by weeks of term. A section is stored as a week whose term
-- is 'S' and whose number is its place in the order, so everything that
-- hangs off a week (readings, slides, sessions, notes, questions) works for
-- sections unchanged. Supervision meetings are sessions of their own kind;
-- a section has notes of its own; a module can carry key dates.

-- Triggers on other tables that name these ones are set aside while the
-- tables are rebuilt, and put back unchanged at the end.
DROP TRIGGER IF EXISTS files_enqueue;
DROP TRIGGER IF EXISTS week_items_priority;
DROP TRIGGER IF EXISTS items_priority;

ALTER TABLE modules ADD COLUMN kind TEXT NOT NULL DEFAULT 'taught';
ALTER TABLE modules ADD COLUMN key_dates TEXT;

-- weeks: term may be 'S', and a section's number is not limited to 11.
CREATE TABLE weeks_new (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL,
  term TEXT NOT NULL CHECK (term IN ('AT', 'WT', 'S')),
  number INTEGER NOT NULL CHECK (number >= 1),
  title TEXT,
  is_reading_week INTEGER NOT NULL DEFAULT 0,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);
INSERT INTO weeks_new (id, module_id, term, number, title, is_reading_week, modified_at, seq, deleted)
  SELECT id, module_id, term, number, title, is_reading_week, modified_at, seq, deleted FROM weeks;
DROP TABLE weeks;
ALTER TABLE weeks_new RENAME TO weeks;
CREATE INDEX weeks_module ON weeks (module_id);
CREATE INDEX weeks_seq ON weeks (seq);
CREATE TRIGGER weeks_seq_insert AFTER INSERT ON weeks
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE weeks SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE TRIGGER weeks_seq_update AFTER UPDATE ON weeks
WHEN NEW.seq = OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE weeks SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;

-- sessions: supervision meetings.
CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('lecture', 'seminar', 'combined', 'supervision')),
  title TEXT,
  position TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);
INSERT INTO sessions_new (id, week_id, kind, title, position, modified_at, seq, deleted)
  SELECT id, week_id, kind, title, position, modified_at, seq, deleted FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX sessions_week ON sessions (week_id);
CREATE INDEX sessions_seq ON sessions (seq);
CREATE TRIGGER sessions_seq_insert AFTER INSERT ON sessions
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE sessions SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE TRIGGER sessions_seq_update AFTER UPDATE ON sessions
WHEN NEW.seq = OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE sessions SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;

-- notes: a section's own notes.
CREATE TABLE notes_new (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  item_id TEXT,
  question_id TEXT,
  week_id TEXT,
  zotero_key TEXT,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  CHECK ((session_id IS NOT NULL) + (item_id IS NOT NULL) + (question_id IS NOT NULL) + (week_id IS NOT NULL) = 1)
);
INSERT INTO notes_new (id, session_id, item_id, question_id, zotero_key, modified_at, seq, deleted)
  SELECT id, session_id, item_id, question_id, zotero_key, modified_at, seq, deleted FROM notes;
DROP TABLE notes;
ALTER TABLE notes_new RENAME TO notes;
CREATE INDEX notes_session ON notes (session_id);
CREATE INDEX notes_item ON notes (item_id);
CREATE INDEX notes_question ON notes (question_id);
CREATE INDEX notes_week ON notes (week_id);
CREATE INDEX notes_seq ON notes (seq);
CREATE TRIGGER notes_seq_insert AFTER INSERT ON notes
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE notes SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE TRIGGER notes_seq_update AFTER UPDATE ON notes
WHEN NEW.seq = OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE notes SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;

-- The triggers set aside above, unchanged.
CREATE TRIGGER files_enqueue AFTER INSERT ON files
WHEN NEW.deleted = 0 AND NEW.text_status = 'pending' AND NEW.mime IN (
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/msword'
)
BEGIN
  INSERT INTO jobs (type, payload, priority) VALUES (
    CASE WHEN NEW.mime = 'application/pdf' THEN 'extract_text' ELSE 'convert' END,
    json_object('file_id', NEW.id),
    (SELECT MIN(CASE w.term WHEN 'AT' THEN 0 ELSE 11 END + w.number)
       FROM items i
       JOIN week_items wi ON wi.item_id = i.id AND wi.deleted = 0
       JOIN weeks w ON w.id = wi.week_id
      WHERE (i.file_id = NEW.id OR i.original_file_id = NEW.id) AND i.deleted = 0)
  );
END;

CREATE TRIGGER week_items_priority AFTER INSERT ON week_items
BEGIN
  UPDATE jobs
     SET priority = MIN(
       COALESCE(priority, 1000),
       COALESCE((SELECT CASE term WHEN 'AT' THEN 0 ELSE 11 END + number FROM weeks WHERE id = NEW.week_id), 1000)
     )
   WHERE status = 'queued'
     AND json_extract(payload, '$.file_id') IN (
       SELECT file_id FROM items WHERE id = NEW.item_id AND file_id IS NOT NULL
       UNION SELECT original_file_id FROM items WHERE id = NEW.item_id AND original_file_id IS NOT NULL
     );
END;

CREATE TRIGGER items_priority AFTER UPDATE OF file_id ON items
WHEN NEW.file_id IS NOT NULL AND (OLD.file_id IS NULL OR NEW.file_id <> OLD.file_id)
BEGIN
  UPDATE jobs
     SET priority = MIN(
       COALESCE(priority, 1000),
       COALESCE((SELECT MIN(CASE w.term WHEN 'AT' THEN 0 ELSE 11 END + w.number)
                   FROM week_items wi JOIN weeks w ON w.id = wi.week_id
                  WHERE wi.item_id = NEW.id AND wi.deleted = 0), 1000)
     )
   WHERE status = 'queued' AND json_extract(payload, '$.file_id') = NEW.file_id;
END;
