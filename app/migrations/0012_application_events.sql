-- Version 0.32: the job search timeline events. One row per event.
-- at is a YYYY-MM-DD date or an ISO timestamp. kind is 'change' (created
-- by changing the stage) or 'manual' (added or edited by hand).
-- cleared_deadline preserves a cleared deadline for undo or change-back.

CREATE TABLE application_events (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  from_stage TEXT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'change',
  cleared_deadline TEXT,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX application_events_app ON application_events (application_id);
CREATE INDEX application_events_seq ON application_events (seq);

CREATE TRIGGER application_events_seq_insert AFTER INSERT ON application_events
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE application_events SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE TRIGGER application_events_seq_update AFTER UPDATE ON application_events
WHEN NEW.seq = OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE application_events SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;

-- Starting entries for existing applications: the Applied entry only.
-- Marked manual so the mis-tap rule never alters them.
INSERT INTO application_events (id, application_id, stage, from_stage, at, kind, cleared_deadline, modified_at, deleted)
  SELECT
    'start-applied-' || id,
    id,
    'applied',
    NULL,
    applied,
    'manual',
    NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    deleted
  FROM applications
  WHERE applied IS NOT NULL AND applied != ''
    AND NOT EXISTS (SELECT 1 FROM application_events WHERE id = 'start-applied-' || applications.id);
