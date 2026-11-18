-- Version 0.51: prepared Listen audio.
-- One row per paragraph and voice that a reader has asked to be prepared. The
-- audio itself is in R2 at listen/<key>.ktm. Rows are the Worker's own
-- bookkeeping and are not synced to devices.

CREATE TABLE listen_audio (
  key TEXT PRIMARY KEY,
  voice TEXT NOT NULL,
  text TEXT NOT NULL,
  item_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  claimed_at TEXT,
  done_at TEXT,
  bytes INTEGER,
  seconds REAL,
  error TEXT
);

CREATE INDEX listen_audio_queue ON listen_audio (status, requested_at, position);
