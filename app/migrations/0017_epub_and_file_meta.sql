-- Version 0.39: EPUB support and file metadata.
-- Adds meta column to files and enqueues EPUB files for conversion.

ALTER TABLE files ADD COLUMN meta TEXT;

DROP TRIGGER files_enqueue;

CREATE TRIGGER files_enqueue AFTER INSERT ON files
WHEN NEW.deleted = 0 AND NEW.text_status = 'pending' AND NEW.mime IN (
  'application/pdf',
  'application/epub+zip',
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
