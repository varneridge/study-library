-- Version 0.34: Item summaries. Adds 'summary' as an allowed kind on items.
-- A summary is a loose item in a week, such as a handout, that opens in the
-- reader but is never ticked, counted towards progress, cited or offered by @.
-- Foreign keys are not used in Study Library, but defer_foreign_keys is enabled
-- as a precaution during the table swap.

PRAGMA defer_foreign_keys = true;

DROP TRIGGER IF EXISTS files_enqueue;
DROP TRIGGER IF EXISTS week_items_priority;
DROP TRIGGER IF EXISTS items_priority;

CREATE TABLE items_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('secondary', 'primary', 'slides', 'summary')),
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
  deleted INTEGER NOT NULL DEFAULT 0,
  last_opened_at TEXT,
  suggested TEXT,
  last_spot TEXT,
  work_kind TEXT,
  editor TEXT,
  publisher TEXT,
  volume TEXT,
  issue TEXT,
  doi TEXT
);

INSERT INTO items_new (
  id, kind, author, title, source, pages, year, doc_date, file_id,
  original_file_id, tray_module_id, zotero_key, last_page, read_status,
  modified_at, seq, deleted, last_opened_at, suggested, last_spot,
  work_kind, editor, publisher, volume, issue, doi
)
  SELECT
    id, kind, author, title, source, pages, year, doc_date, file_id,
    original_file_id, tray_module_id, zotero_key, last_page, read_status,
    modified_at, seq, deleted, last_opened_at, suggested, last_spot,
    work_kind, editor, publisher, volume, issue, doi
  FROM items;

DROP TABLE items;
ALTER TABLE items_new RENAME TO items;

CREATE INDEX items_file ON items (file_id);
CREATE INDEX items_zotero ON items (zotero_key);
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
