-- Version 0.11: no language model is used anywhere, so no summaries are
-- written. Imported transcripts no longer queue one, and anything waiting
-- for a summary is finished as it is.

DROP TRIGGER IF EXISTS recordings_imported_summary;
DELETE FROM jobs WHERE type = 'summarise' AND status IN ('queued', 'running', 'failed');
UPDATE recordings SET status = 'done', modified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status = 'summarising';
