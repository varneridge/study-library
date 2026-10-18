-- Version 0.22: columns left from versions that matched notes to moments in
-- a recording, grouped transcripts by slide and wrote summaries. Nothing
-- reads or writes them now. No index or trigger uses them.
ALTER TABLE recordings DROP COLUMN summary;
ALTER TABLE recordings DROP COLUMN slide_marks;
ALTER TABLE note_blocks DROP COLUMN offset_seconds;
ALTER TABLE note_blocks DROP COLUMN recording_id;
