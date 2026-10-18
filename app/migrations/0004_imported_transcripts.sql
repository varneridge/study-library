-- Version 0.9: transcripts imported from Moodle. A recording can carry its
-- transcript as speaker turns, with no audio. Each turn is indexed for
-- search, and a summary is queued as for any other recording.

ALTER TABLE recordings ADD COLUMN turns TEXT;

CREATE TRIGGER recordings_turns_insert AFTER INSERT ON recordings
WHEN NEW.turns IS NOT NULL
BEGIN
  DELETE FROM transcript_text WHERE recording_id = NEW.id;
  INSERT INTO transcript_text (body, recording_id, start_seconds, end_seconds)
    SELECT json_extract(value, '$.text'), NEW.id, CAST(key AS REAL), CAST(key AS REAL) FROM json_each(NEW.turns);
END;

CREATE TRIGGER recordings_turns_update AFTER UPDATE OF turns ON recordings
WHEN NEW.turns IS NOT NULL AND (OLD.turns IS NULL OR NEW.turns <> OLD.turns)
BEGIN
  DELETE FROM transcript_text WHERE recording_id = NEW.id;
  INSERT INTO transcript_text (body, recording_id, start_seconds, end_seconds)
    SELECT json_extract(value, '$.text'), NEW.id, CAST(key AS REAL), CAST(key AS REAL) FROM json_each(NEW.turns);
END;

CREATE TRIGGER recordings_imported_summary AFTER INSERT ON recordings
WHEN NEW.turns IS NOT NULL AND NEW.status = 'summarising' AND NEW.deleted = 0
BEGIN
  INSERT INTO jobs (type, payload, priority) VALUES ('summarise', json_object('recording_id', NEW.id), -1);
END;
