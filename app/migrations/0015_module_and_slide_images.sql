-- Version 0.35: Module cover pictures and slide thumbnails.
-- Adds image_key to modules for home page cover pictures,
-- and thumb_key to files for slide deck first page previews.

ALTER TABLE modules ADD COLUMN image_key TEXT;
ALTER TABLE files ADD COLUMN thumb_key TEXT;
