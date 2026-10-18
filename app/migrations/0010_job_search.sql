-- Version 0.23: the job search. One row per application. Stages are stored
-- by key (see STAGES in src/lib/jobs.ts). Dates are YYYY-MM-DD. Each file
-- slot is JSON: {"state":"na"} or {"state":"saved", ...}, or empty when
-- nothing is recorded yet.

CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  employer TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  applied TEXT,
  stage TEXT NOT NULL DEFAULT 'applied',
  next_deadline TEXT,
  notes TEXT,
  file_cv TEXT,
  file_cl TEXT,
  file_rd TEXT,
  file_qs TEXT,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX applications_seq ON applications (seq);
CREATE TRIGGER applications_seq_insert AFTER INSERT ON applications
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE applications SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE TRIGGER applications_seq_update AFTER UPDATE ON applications
WHEN NEW.seq = OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE applications SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;

-- The two applications from the spreadsheet. A tick there means sent and
-- saved, with no file attached yet.
INSERT INTO applications (id, employer, role, applied, stage, next_deadline, notes, file_cv, file_cl, file_rd, file_qs, modified_at)
VALUES
  ('kekst-2026', 'Kekst CNC', 'Summer 2026 Internship', '2026-02-26', 'rejected', NULL, NULL,
   '{"state":"saved"}', '{"state":"saved"}', '{"state":"saved"}', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('dragonfly-2026', 'Dragonfly Intelligence', 'Summer 2026 Research Internship, Intelligence Team', '2026-02-17', 'no_response', NULL, NULL,
   NULL, '{"state":"saved"}', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
