-- Version 0.20: transcripts are plain text, for accuracy. Transcripts made
-- earlier with time stamps are joined into text in the same form, and the
-- recordings' trigger re-indexes them for search.
UPDATE recordings
   SET turns = json_array(json_object('speaker', '', 'text', (
         SELECT group_concat(body, ' ') FROM (
           SELECT body FROM transcript_text WHERE recording_id = recordings.id ORDER BY start_seconds
         )
       ))),
       modified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE turns IS NULL
   AND EXISTS (SELECT 1 FROM transcript_text WHERE recording_id = recordings.id);
