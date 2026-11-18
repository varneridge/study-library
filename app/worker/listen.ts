// Prepared Listen audio: paragraphs a reader asks for are queued here, an audio
// preparation worker (backend/tts/prepare.py, on the laptop or the desktop)
// claims them, synthesises them with the full Kokoro model and uploads the
// result, and any device then plays the finished file instead of running
// Kokoro itself. The Worker only keeps the list and moves bytes, so each
// request stays well inside the free plan's CPU limit.
//
// Audio is stored by content (src/lib/listen/preparedKey.ts) at
// listen/<key>.ktm: "KTM1", a little-endian uint32 header length, a JSON header
// {sampleRate, samples, voice, modelVersion, tokens}, then MP3.

import { Hono } from "hono";
import { requireProcessor } from "./auth";
import { NOW, type Env } from "./env";
import { isPreparedAudioKey, preparedAudioKey } from "../src/lib/listen/preparedKey";

/** Most paragraphs one request may ask for; a long book asks in several requests. */
export const MAX_PREPARE = 400;
/** Most paragraphs one claim hands out, so a worker that stops leaves little stranded. */
const MAX_CLAIM = 16;
/** A claim not finished in this long is handed out again. */
const LEASE_MINUTES = 10;
const MAX_ATTEMPTS = 3;
/** Larger than any 400-character paragraph at 48 kbps, so anything bigger is a mistake. */
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const MAGIC = [0x4b, 0x54, 0x4d, 0x31]; // "KTM1"
/** Kinds of machine, best first. A "basic" one (the compressed model) never prepares. */
const TIERS = ["gpu", "cpu"] as const;
type Tier = (typeof TIERS)[number];
/** A processor-only machine leaves new paragraphs this long for a machine with a graphics card. */
const CPU_WAIT_MINUTES = 3;
/** A machine with a graphics card counts as present for this long after its last claim. */
const GPU_PRESENT_SECONDS = 5 * 60;
/** Audio made without a graphics card is remade for readings asked for within this many days. */
const UPGRADE_DAYS = 7;

const VOICE = /^[ab][fm]_[a-z]+$/;

export function objectKey(key: string): string {
  return `listen/${key}.ktm`;
}

export const listen = new Hono<{ Bindings: Env }>();

/**
 * Queue a reading's paragraphs for one voice, in reading order. Paragraphs
 * already prepared are left as they are, ones that failed are tried again, and
 * every one is marked as just asked for, so the reading open now is prepared
 * before readings asked for earlier.
 */
listen.post("/prepare", async (c) => {
  const body = await c.req.json<{ itemId?: unknown; voice?: unknown; utterances?: unknown }>().catch(() => null);
  const voice = typeof body?.voice === "string" ? body.voice : "";
  if (!VOICE.test(voice)) return c.json({ error: "Unknown voice." }, 400);
  const itemId = typeof body?.itemId === "string" ? body.itemId.slice(0, 100) : null;
  const texts = (Array.isArray(body?.utterances) ? body.utterances : [])
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .slice(0, MAX_PREPARE)
    .map((t) => t.slice(0, 1000));
  if (texts.length === 0) return c.json({ items: [] });
  const keys = await Promise.all(texts.map((t) => preparedAudioKey(voice, t)));
  const statements = texts.map((text, i) =>
    c.env.DB.prepare(
      `INSERT INTO listen_audio (key, voice, text, item_id, position) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (key) DO UPDATE SET
         requested_at = ${NOW}, item_id = excluded.item_id, position = excluded.position,
         attempts = CASE WHEN status = 'failed' THEN 0 ELSE attempts END,
         status = CASE WHEN status = 'failed' THEN 'queued' ELSE status END
       RETURNING key, status, tier`,
    ).bind(keys[i], voice, text, itemId, i),
  );
  const results = await c.env.DB.batch<{ key: string; status: string; tier: string | null }>(statements);
  const items = results.map((r, i) => {
    const row = r.results?.[0];
    const ready = row?.status === "done" || row?.status === "upgrading";
    return { key: keys[i], ready, tier: ready ? (row?.tier ?? null) : null };
  });
  return c.json({ items });
});

/** One paragraph's prepared audio, if it is ready. Its key names its content, so it never changes. */
listen.get("/audio/:key", async (c) => {
  const key = c.req.param("key");
  if (!isPreparedAudioKey(key)) return c.json({ error: "Not a prepared audio key." }, 400);
  const object = await c.env.BUCKET.get(objectKey(key));
  if (!object) return c.json({ error: "Not prepared yet." }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/x-kokoro-prepared",
      "Content-Length": String(object.size),
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
});

/** Endpoints for the audio preparation worker, behind the processor key. */
export const listenProcessor = new Hono<{ Bindings: Env }>();
listenProcessor.use("*", requireProcessor);

/**
 * Hand out the next paragraphs: the reading asked for most recently, from its
 * start. A machine says what kind it is. One with a graphics card ("gpu") gets
 * new paragraphs at once and, when none are waiting, remakes audio a
 * processor-only machine made. A processor-only one ("cpu") gets a paragraph
 * only once it has waited a few minutes, or at once when no machine with a
 * graphics card has claimed lately, so the laptop stays quiet while the
 * desktop is on but readings are still prepared when it is not.
 */
listenProcessor.post("/claim", async (c) => {
  const body = await c.req.json<{ limit?: number; tier?: string }>().catch(() => ({}) as { limit?: number; tier?: string });
  const limit = Math.min(Math.max(Number(body.limit) || 8, 1), MAX_CLAIM);
  const tier: Tier = (TIERS as readonly string[]).includes(String(body.tier)) ? (body.tier as Tier) : "cpu";
  const lease = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${LEASE_MINUTES} minutes')`;
  let waitClause = "";
  if (tier === "gpu") {
    await c.env.DB.prepare(
      `INSERT INTO counters (name, value) VALUES ('listen_gpu_seen', CAST(strftime('%s', 'now') AS INTEGER))
       ON CONFLICT (name) DO UPDATE SET value = excluded.value`,
    ).run();
  } else {
    const seen = await c.env.DB.prepare("SELECT value FROM counters WHERE name = 'listen_gpu_seen'").first<{ value: number }>();
    const gpuPresent = !!seen && Date.now() / 1000 - seen.value < GPU_PRESENT_SECONDS;
    if (gpuPresent) waitClause = `AND requested_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${CPU_WAIT_MINUTES} minutes')`;
  }
  const claim = (where: string, status: string) =>
    c.env.DB.prepare(
      `UPDATE listen_audio SET status = '${status}', claimed_at = ${NOW}, attempts = attempts + 1
        WHERE key IN (SELECT key FROM listen_audio WHERE ${where} ORDER BY requested_at DESC, position LIMIT ?1)
        RETURNING key, voice, text, requested_at, position`,
    ).bind(limit).all<{ key: string; voice: string; text: string; requested_at: string; position: number }>();
  let claimed = await claim(`(status = 'queued' ${waitClause}) OR (status = 'running' AND claimed_at < ${lease})`, "running");
  if (tier === "gpu" && (claimed.results ?? []).length === 0) {
    claimed = await claim(
      `(status = 'done' AND tier IN ('cpu', 'basic') AND requested_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${UPGRADE_DAYS} days'))
        OR (status = 'upgrading' AND claimed_at < ${lease})`,
      "upgrading",
    );
  }
  const rows = (claimed.results ?? []).sort((a, b) => (a.requested_at === b.requested_at ? a.position - b.position : a.requested_at < b.requested_at ? 1 : -1));
  return c.json({ items: rows.map(({ key, voice, text }) => ({ key, voice, text })) });
});

listenProcessor.put("/audio/:key", async (c) => {
  const key = c.req.param("key");
  if (!isPreparedAudioKey(key)) return c.json({ error: "Not a prepared audio key." }, 400);
  const row = await c.env.DB.prepare("SELECT key FROM listen_audio WHERE key = ?1").bind(key).first();
  if (!row) return c.json({ error: "Nothing was asked for under that key." }, 404);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length < 8 || bytes.length > MAX_AUDIO_BYTES || MAGIC.some((b, i) => bytes[i] !== b)) {
    return c.json({ error: "Not a prepared audio file." }, 400);
  }
  const seconds = Number(c.req.header("x-listen-seconds")) || null;
  const tierHeader = c.req.header("x-listen-tier");
  const tier = tierHeader === "gpu" || tierHeader === "cpu" || tierHeader === "basic" ? tierHeader : null;
  await c.env.BUCKET.put(objectKey(key), bytes, { httpMetadata: { contentType: "application/x-kokoro-prepared" } });
  await c.env.DB.prepare(
    `UPDATE listen_audio SET status = 'done', done_at = ${NOW}, bytes = ?2, seconds = ?3, tier = ?4, error = NULL, attempts = 0 WHERE key = ?1`,
  ).bind(key, bytes.length, seconds, tier).run();
  return c.json({ ok: true });
});

listenProcessor.post("/audio/:key/fail", async (c) => {
  const key = c.req.param("key");
  const { error } = await c.req.json<{ error?: string }>().catch(() => ({}) as { error?: string });
  const row = await c.env.DB.prepare("SELECT attempts, status FROM listen_audio WHERE key = ?1").bind(key).first<{ attempts: number; status: string }>();
  if (!row) return c.json({ error: "Nothing was asked for under that key." }, 404);
  if (row.status === "upgrading") {
    // Remaking audio failed: the audio already there stays, so it is simply done again.
    await c.env.DB.prepare("UPDATE listen_audio SET status = 'done', claimed_at = NULL WHERE key = ?1").bind(key).run();
    return c.json({ final: true });
  }
  const final = row.attempts >= MAX_ATTEMPTS;
  await c.env.DB.prepare("UPDATE listen_audio SET status = ?2, error = ?3, claimed_at = NULL WHERE key = ?1")
    .bind(key, final ? "failed" : "queued", String(error ?? "").slice(0, 2000)).run();
  return c.json({ final });
});

/** Most readings the status lists, as it lists at most thirty jobs. */
export const STATUS_LISTEN_LIMIT = 30;

/** One reading's prepared audio in one voice that is waiting, being made or has failed, as Settings lists it. */
export interface StatusListen {
  item_id: string | null;
  voice: string;
  title: string | null;
  state: "running" | "upgrading" | "queued" | "failed";
  /** Paragraphs that already play, which includes those being remade. */
  ready: number;
  total: number;
  failed: number;
  requested_at: string | null;
}

/**
 * The readings with Listen audio in hand, one row for each reading and voice:
 * those being made first, then those being remade, then those waiting, then
 * those that failed. Within each, the reading asked for most recently comes
 * first, as /claim hands them out. The groups are found from the active rows
 * alone, and each one's counts by seeks on listen_audio_status
 * (migration 0023), so the poll Settings makes every minute never reads every
 * paragraph ever prepared.
 */
export function listenStatusStatement(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `SELECT g.item_id, g.voice, g.requested_at, g.running, g.upgrading, g.queued, g.failed,
            (SELECT COUNT(*) FROM listen_audio d
              WHERE d.status IN ('done', 'upgrading') AND d.item_id IS g.item_id AND d.voice = g.voice) AS ready,
            (SELECT COUNT(*) FROM listen_audio t
              WHERE t.status IN ('queued', 'running', 'upgrading', 'done', 'failed') AND t.item_id IS g.item_id AND t.voice = g.voice) AS total,
            (SELECT i.title FROM items i WHERE i.id = g.item_id) AS title
       FROM (SELECT item_id, voice, MAX(requested_at) AS requested_at,
                    SUM(status = 'running') AS running, SUM(status = 'upgrading') AS upgrading,
                    SUM(status = 'queued') AS queued, SUM(status = 'failed') AS failed
               FROM listen_audio
              WHERE status IN ('running', 'upgrading', 'queued', 'failed')
              GROUP BY item_id, voice) g
      ORDER BY CASE WHEN g.running > 0 THEN 0 WHEN g.upgrading > 0 THEN 1 WHEN g.queued > 0 THEN 2 ELSE 3 END,
               g.requested_at DESC
      LIMIT ?1`,
  ).bind(STATUS_LISTEN_LIMIT);
}

/** A row of listenStatusStatement as the status sends it. */
export function statusListen(row: Record<string, unknown>): StatusListen {
  const count = (value: unknown) => Math.max(0, Number(value) || 0);
  const state: StatusListen["state"] =
    count(row.running) > 0 ? "running" : count(row.upgrading) > 0 ? "upgrading" : count(row.queued) > 0 ? "queued" : "failed";
  return {
    item_id: typeof row.item_id === "string" ? row.item_id : null,
    voice: String(row.voice ?? ""),
    title: typeof row.title === "string" && row.title ? row.title.slice(0, 200) : null,
    state,
    ready: count(row.ready),
    total: count(row.total),
    failed: count(row.failed),
    requested_at: typeof row.requested_at === "string" ? row.requested_at : null,
  };
}
