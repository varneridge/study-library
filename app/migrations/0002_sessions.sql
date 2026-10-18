-- Phases 3 to 5: questions, notes, recordings and transcripts.

CREATE INDEX questions_session ON questions (session_id);
CREATE INDEX highlights_question ON highlights (question_id);
CREATE INDEX recordings_session ON recordings (session_id);
CREATE INDEX notes_session ON notes (session_id);
CREATE INDEX notes_item ON notes (item_id);
CREATE INDEX notes_question ON notes (question_id);

-- A recording is processed once its audio is fully uploaded. Recordings go
-- ahead of readings in the queue, because notes link to them straight away.
CREATE TRIGGER recordings_ready_insert AFTER INSERT ON recordings
WHEN NEW.status = 'uploaded' AND NEW.deleted = 0
BEGIN
  INSERT INTO jobs (type, payload, priority) VALUES ('prepare_audio', json_object('recording_id', NEW.id), -1);
END;

CREATE TRIGGER recordings_ready_update AFTER UPDATE OF status ON recordings
WHEN NEW.status = 'uploaded' AND OLD.status <> 'uploaded' AND NEW.deleted = 0
BEGIN
  INSERT INTO jobs (type, payload, priority) VALUES ('prepare_audio', json_object('recording_id', NEW.id), -1);
END;
