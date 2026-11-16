-- The calendar's own events. Dates are ISO (YYYY-MM-DD) and times are wall
-- clock HH:MM, so a 10:00 lecture stays at 10:00 across the change to and
-- from British Summer Time. end_date is inclusive, and both times are null
-- exactly when all_day is 1. The Google Calendar cache is not stored here,
-- because each device rebuilds it from the feed.

CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  modified_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER,
  title TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'other',
  location TEXT,
  notes TEXT
);

CREATE INDEX calendar_events_seq ON calendar_events(seq);

-- Every insert and every edit takes the next number from the shared counter,
-- so a device pulling changes since its cursor sees this row. The update
-- trigger fires only when seq itself is unchanged, so its own write of seq
-- never sets it off again, whatever recursive_triggers is set to.
CREATE TRIGGER calendar_events_seq_insert AFTER INSERT ON calendar_events
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE calendar_events SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;

CREATE TRIGGER calendar_events_seq_update AFTER UPDATE ON calendar_events
WHEN NEW.seq IS OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE calendar_events SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
