-- Study Library schema for Cloudflare D1.
--
-- Synced tables share three columns. modified_at is set by the device that
-- made the edit and decides conflicts. seq comes from a global counter and is
-- set by triggers on every write, so pulling means asking for seq above a
-- cursor. deleted marks tombstones.
--
-- There are no foreign keys. Rows arrive from several devices in any order,
-- and the app treats a row whose parent is missing as absent.
-- JSON columns are stored as text. Booleans are 0 or 1.

CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO counters (name, value) VALUES ('seq', 0);

CREATE TABLE modules (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  title TEXT,
  session_pattern TEXT NOT NULL DEFAULT '["lecture","seminar"]',
  description TEXT,
  last_opened_week_id TEXT,
  position TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE weeks (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL,
  term TEXT NOT NULL CHECK (term IN ('AT', 'WT')),
  number INTEGER NOT NULL CHECK (number BETWEEN 1 AND 11),
  title TEXT,
  is_reading_week INTEGER NOT NULL DEFAULT 0,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('lecture', 'seminar', 'combined')),
  title TEXT,
  position TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  original_name TEXT,
  page_count INTEGER,
  text_status TEXT NOT NULL DEFAULT 'pending',
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('secondary', 'primary', 'slides')),
  author TEXT,
  title TEXT NOT NULL,
  source TEXT,
  pages TEXT,
  year INTEGER,
  doc_date TEXT,
  file_id TEXT,
  original_file_id TEXT,
  tray_module_id TEXT,
  zotero_key TEXT,
  last_page INTEGER,
  read_status TEXT NOT NULL DEFAULT 'unread',
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE week_items (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  session_id TEXT,
  position TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  body TEXT NOT NULL,
  position TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);

-- page is a zero-based page index. rects is a JSON list of [x1, y1, x2, y2]
-- in PDF points, the same format Zotero uses.
CREATE TABLE highlights (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  rects TEXT NOT NULL,
  body TEXT,
  colour TEXT NOT NULL,
  comment TEXT,
  question_id TEXT,
  zotero_key TEXT,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('live', 'upload')),
  file_id TEXT,
  duration_seconds REAL,
  slide_marks TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'recording',
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  item_id TEXT,
  question_id TEXT,
  zotero_key TEXT,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  CHECK ((session_id IS NOT NULL) + (item_id IS NOT NULL) + (question_id IS NOT NULL) = 1)
);

CREATE TABLE note_blocks (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  position TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  recording_id TEXT,
  offset_seconds REAL,
  highlight_id TEXT,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);

-- Server-only tables

CREATE VIRTUAL TABLE page_text USING fts5(
  body, file_id UNINDEXED, page UNINDEXED, tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE transcript_text USING fts5(
  body, recording_id UNINDEXED, start_seconds UNINDEXED, end_seconds UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  finished_at TEXT,
  error TEXT
);

CREATE INDEX jobs_queue ON jobs (status, priority, id);
CREATE INDEX weeks_module ON weeks (module_id);
CREATE INDEX sessions_week ON sessions (week_id);
CREATE INDEX files_sha ON files (sha256);
CREATE INDEX items_file ON items (file_id);
CREATE INDEX items_zotero ON items (zotero_key);
CREATE INDEX week_items_week ON week_items (week_id);
CREATE INDEX week_items_item ON week_items (item_id);
CREATE INDEX highlights_item ON highlights (item_id);
CREATE INDEX note_blocks_note ON note_blocks (note_id);

-- Job queue triggers.
-- Priority follows week order: AT1 is 1 and WT11 is 22. Unplaced files wait at 1000.

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

-- seq triggers. Each write takes the next value of the global counter.
-- The update trigger skips writes that changed seq, so it never loops.

CREATE INDEX modules_seq ON modules (seq);
CREATE TRIGGER modules_seq_insert AFTER INSERT ON modules
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE modules SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE TRIGGER modules_seq_update AFTER UPDATE ON modules
WHEN NEW.seq = OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE modules SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;

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

CREATE INDEX files_seq ON files (seq);
CREATE TRIGGER files_seq_insert AFTER INSERT ON files
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE files SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE TRIGGER files_seq_update AFTER UPDATE ON files
WHEN NEW.seq = OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE files SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;

CREATE INDEX items_seq ON items (seq);
CREATE TRIGGER items_seq_insert AFTER INSERT ON items
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE items SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE TRIGGER items_seq_update AFTER UPDATE ON items
WHEN NEW.seq = OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE items SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;

CREATE INDEX week_items_seq ON week_items (seq);
CREATE TRIGGER week_items_seq_insert AFTER INSERT ON week_items
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE week_items SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE TRIGGER week_items_seq_update AFTER UPDATE ON week_items
WHEN NEW.seq = OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE week_items SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;

CREATE INDEX questions_seq ON questions (seq);
CREATE TRIGGER questions_seq_insert AFTER INSERT ON questions
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE questions SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE TRIGGER questions_seq_update AFTER UPDATE ON questions
WHEN NEW.seq = OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE questions SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;

CREATE INDEX highlights_seq ON highlights (seq);
CREATE TRIGGER highlights_seq_insert AFTER INSERT ON highlights
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE highlights SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE TRIGGER highlights_seq_update AFTER UPDATE ON highlights
WHEN NEW.seq = OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE highlights SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;

CREATE INDEX recordings_seq ON recordings (seq);
CREATE TRIGGER recordings_seq_insert AFTER INSERT ON recordings
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE recordings SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE TRIGGER recordings_seq_update AFTER UPDATE ON recordings
WHEN NEW.seq = OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE recordings SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;

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

CREATE INDEX note_blocks_seq ON note_blocks (seq);
CREATE TRIGGER note_blocks_seq_insert AFTER INSERT ON note_blocks
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE note_blocks SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE TRIGGER note_blocks_seq_update AFTER UPDATE ON note_blocks
WHEN NEW.seq = OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE note_blocks SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
