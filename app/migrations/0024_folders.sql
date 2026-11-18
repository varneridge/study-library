-- Version 0.55: folders on Library shelves, for things such as a book series.
-- A folder belongs to one shelf (a week of a Library module) and is one level
-- deep. A reading on a shelf is in a folder when its week_items row names one;
-- readings with no folder_id stay loose on the shelf, as every reading was before.

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL,
  title TEXT,
  position TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX folders_seq ON folders (seq);
-- Every synced table numbers its changes, so devices pull them in order.
CREATE TRIGGER folders_seq_insert AFTER INSERT ON folders
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE folders SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE TRIGGER folders_seq_update AFTER UPDATE ON folders
WHEN NEW.seq = OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE folders SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE INDEX folders_week ON folders (week_id);

ALTER TABLE week_items ADD COLUMN folder_id TEXT;
