-- Version 0.18: the exact place you stopped in a reading, not just the page.
-- {"page": 3, "frac": 0.42, "at": 1180}: the page, how far down it, and in
-- text layout the character the screen began at.
ALTER TABLE items ADD COLUMN last_spot TEXT;
