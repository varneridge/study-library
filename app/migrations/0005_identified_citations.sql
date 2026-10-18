-- Version 0.10: readings name themselves. When a PDF's text is ready, the
-- processor works out its citation. A reading with no author or year takes
-- it straight away; any other gets it as a suggestion to accept or dismiss.

ALTER TABLE items ADD COLUMN suggested TEXT;

CREATE TRIGGER files_identify AFTER UPDATE OF text_status ON files
WHEN NEW.text_status = 'ready' AND OLD.text_status <> 'ready' AND NEW.deleted = 0 AND NEW.mime = 'application/pdf'
BEGIN
  INSERT INTO jobs (type, payload, priority) VALUES ('identify', json_object('file_id', NEW.id), 2000);
END;

-- Readings already in the library are looked at once, after everything else.
INSERT INTO jobs (type, payload, priority)
  SELECT 'identify', json_object('file_id', id), 2000 FROM files
   WHERE deleted = 0 AND text_status = 'ready' AND mime = 'application/pdf';
