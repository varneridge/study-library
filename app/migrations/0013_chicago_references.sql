-- Version 0.33: Chicago 18th edition reference fields on readings.
-- work_kind is 'article', 'chapter', 'book', or 'primary'.
-- editor stores volume editors in "Surname, Given" form, joined with commas and "and".
-- publisher stores the publisher name (Chicago 18th edition omits place of publication).
-- volume, issue and doi hold the container volume, issue and DOI or stable URL.

ALTER TABLE items ADD COLUMN work_kind TEXT;
ALTER TABLE items ADD COLUMN editor TEXT;
ALTER TABLE items ADD COLUMN publisher TEXT;
ALTER TABLE items ADD COLUMN volume TEXT;
ALTER TABLE items ADD COLUMN issue TEXT;
ALTER TABLE items ADD COLUMN doi TEXT;
