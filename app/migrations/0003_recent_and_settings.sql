-- Version 0.4: when each reading was last opened, for the home page, and a
-- small synced settings table, first used for highlight colour names.

ALTER TABLE items ADD COLUMN last_opened_at TEXT;

CREATE TABLE settings (
  id TEXT PRIMARY KEY,
  value TEXT,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX settings_seq ON settings (seq);
CREATE TRIGGER settings_seq_insert AFTER INSERT ON settings
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE settings SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE TRIGGER settings_seq_update AFTER UPDATE ON settings
WHEN NEW.seq = OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE settings SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
