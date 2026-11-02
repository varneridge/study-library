-- Version 0.39: Custom week covers.
-- Adds image_key to weeks for custom cover pictures.

ALTER TABLE weeks ADD COLUMN image_key TEXT;
