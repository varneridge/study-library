-- Settings lists the Listen audio in hand, one row for each reading and voice
-- (listenStatusStatement in worker/listen.ts). The status poll finds the
-- readings from their waiting, running, remade and failed paragraphs, then
-- counts each reading's ready and total paragraphs. This index answers both
-- by seeks rather than by reading every paragraph ever prepared, which
-- matters because Settings polls once a minute in every open tab and D1
-- counts every row it reads.

CREATE INDEX IF NOT EXISTS listen_audio_status ON listen_audio (status, item_id, voice);
