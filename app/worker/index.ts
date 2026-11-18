import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { requireAccess } from "./auth";
import { accessEmail, connectLink } from "./connect";
import type { Env } from "./env";
import { bumpFile, completeUpload, redoFile, REDO_STEPS, retryFile, serveObject, startUpload, storeUpload, uploadPart, queueRescan, queueThumbs } from "./files";
import { retryRecording, storeChunk, transcribeRecording } from "./recordings";
import { servePicture, storePicture } from "./pictures";
import { proxyIcsFeed } from "./calendarProxy";
import { search } from "./search";
import { maintain, purge } from "./maintenance";
import { serveModelFile } from "./models";
import { JOB_CLAIM_ORDER, processor } from "./processor";
import { listen, listenProcessor, listenStatusStatement, spend, statusListen } from "./listen";
import { ROW_COST } from "../src/lib/listen/limits";
import { TABLE_NAMES } from "./schema";
import { pull, push, type Change } from "./sync";

const app = new Hono<{ Bindings: Env }>();

app.onError((error, c) => c.json({ error: error.message }, 500));

app.use("/api/*", requireAccess);

app.get("/api/ping", (c) => c.json({ ok: true }));

// The jobs Settings lists, at most this many: running first, then queued in
// the order the processor takes them (JOB_CLAIM_ORDER), then the latest
// failures. SELECT * keeps the status answering whichever optional columns this
// database has, since one unknown column would fail the whole batch, and a
// payload is a small JSON object, so thirty stay cheap to read.
const STATUS_JOB_LIMIT = 30;

// What each job is for, in words: the reading a file or item belongs to (a
// converted file's reading now points at its PDF, named <id>:pdf), or the
// module, week and session of a recording. Each lookup is by primary key or
// an index, so thirty jobs stay cheap, and json_valid comes first because
// json_extract on a payload that is not JSON would fail the whole batch.
const JOB_TARGET_TITLE = `CASE WHEN json_valid(j.payload) THEN COALESCE(
    (SELECT i.title FROM items i WHERE i.id = json_extract(j.payload, '$.item_id') AND i.deleted = 0),
    (SELECT i.title FROM items i WHERE i.file_id = json_extract(j.payload, '$.file_id') AND i.deleted = 0 ORDER BY i.id LIMIT 1),
    (SELECT i.title FROM items i WHERE i.file_id = json_extract(j.payload, '$.file_id') || ':pdf' AND i.deleted = 0 ORDER BY i.id LIMIT 1),
    (SELECT COALESCE(m.code || ', ', '') || COALESCE(NULLIF(s.title, ''),
              CASE w.term WHEN 'AT' THEN 'Autumn Term' ELSE 'Winter Term' END || ' week ' || w.number || ' '
              || CASE s.kind WHEN 'lecture' THEN 'lecture' ELSE 'seminar' END)
       FROM recordings r JOIN sessions s ON s.id = r.session_id JOIN weeks w ON w.id = s.week_id
       LEFT JOIN modules m ON m.id = w.module_id
      WHERE r.id = json_extract(j.payload, '$.recording_id')),
    (SELECT NULLIF(f.original_name, 'recording') FROM files f WHERE f.id = json_extract(j.payload, '$.file_id'))
  ) END`;

interface StatusJob {
  id: number;
  kind: string;
  status: string;
  target_id: string | null;
  // What the target is, from its payload key: file, recording or item.
  target_kind: string | null;
  label: string | null;
  title: string | null;
  attempts: number;
  error: string | null;
  // When a job waiting to try again may next be taken.
  run_after: string | null;
}

function statusJob(row: Record<string, unknown>): StatusJob {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = typeof row.payload === "string" ? JSON.parse(row.payload) : null;
    if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
  } catch {
    // A payload that is not JSON still lists its job, only without a target.
  }
  const targetKey = Object.keys(payload).find(
    (key) => key.endsWith("_id") && (typeof payload[key] === "string" || typeof payload[key] === "number"),
  );
  const label = [payload.label, payload.title, payload.name].find((v): v is string => typeof v === "string" && v.length > 0);
  return {
    id: Number(row.id ?? row.job_rowid),
    kind: typeof row.type === "string" && row.type ? row.type : "job",
    status: String(row.status),
    target_id: targetKey ? String(payload[targetKey]) : null,
    target_kind: targetKey ? targetKey.replace(/_id$/, "") : null,
    label: label ? label.slice(0, 120) : null,
    title: typeof row.target_title === "string" && row.target_title ? row.target_title.slice(0, 200) : null,
    attempts: Number(row.attempts) || 0,
    error: typeof row.error === "string" && row.error ? row.error.slice(0, 300) : null,
    run_after: row.status === "queued" && typeof row.run_after === "string" ? row.run_after : null,
  };
}

// When the processor last asked for work, and when a speech computer with a
// graphics card last asked for Listen audio, how much is waiting, the jobs
// themselves and the readings whose Listen audio is in hand. Clients from
// before the lists simply ignore the extra fields.
app.get("/api/status", async (c) => {
  const [seen, jobs, list, listenList] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT name, value FROM counters WHERE name IN ('processor_seen', 'listen_gpu_seen')"),
    c.env.DB.prepare(
      `SELECT SUM(status = 'queued') AS queued, SUM(status = 'running') AS running, SUM(status = 'failed') AS failed FROM jobs`,
    ),
    c.env.DB.prepare(
      `SELECT j.rowid AS job_rowid, j.*, ${JOB_TARGET_TITLE} AS target_title
         FROM jobs j WHERE j.status IN ('running', 'queued', 'failed')
        ORDER BY CASE j.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
                 CASE WHEN j.status = 'failed' THEN -j.id ELSE 0 END,
                 ${JOB_CLAIM_ORDER}
        LIMIT ?1`,
    ).bind(STATUS_JOB_LIMIT),
    listenStatusStatement(c.env.DB),
  ]);
  const row = (jobs.results?.[0] ?? {}) as { queued?: number | null; running?: number | null; failed?: number | null };
  const counters = (seen.results ?? []) as { name: string; value: number | null }[];
  const counter = (name: string) => counters.find((r) => r.name === name)?.value ?? null;
  return c.json({
    processor_seen: counter("processor_seen"),
    listen_gpu_seen: counter("listen_gpu_seen"),
    queued: row.queued ?? 0,
    running: row.running ?? 0,
    failed: row.failed ?? 0,
    jobs: ((list.results ?? []) as Record<string, unknown>[]).map(statusJob),
    listen: ((listenList.results ?? []) as Record<string, unknown>[]).map(statusListen),
  });
});

// Sends queued work to the top of its queue, as Settings offers for work
// waiting behind what comes next. A job takes a priority below every queued
// job's, since the processor takes the lowest first (JOB_CLAIM_ORDER), and a
// reading's Listen audio in one voice is marked as asked for after every
// reading in hand, a millisecond later where one shares this instant, since
// /claim hands out the reading asked for most recently first. Work that has
// started meanwhile is left where it is, and ok says whether anything moved.
app.post("/api/status/prioritise", async (c) => {
  const body = await c.req.json<{ source?: unknown; id?: unknown; itemId?: unknown; voice?: unknown }>().catch(() => null);
  if (body?.source === "job" && typeof body.id === "number" && Number.isInteger(body.id)) {
    const result = await c.env.DB.prepare(
      `UPDATE jobs SET priority = (SELECT COALESCE(MIN(priority), 0) - 1 FROM jobs WHERE status = 'queued')
        WHERE id = ?1 AND status = 'queued'`,
    ).bind(body.id).run();
    return c.json({ ok: (result.meta?.changes ?? 0) > 0 });
  }
  if (body?.source === "listen" && typeof body.voice === "string") {
    const itemId = typeof body.itemId === "string" ? body.itemId : null;
    const result = await c.env.DB.prepare(
      `UPDATE listen_audio SET requested_at = (
         SELECT CASE WHEN MAX(requested_at) >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                     THEN strftime('%Y-%m-%dT%H:%M:%fZ', MAX(requested_at), '+0.001 seconds')
                     ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
           FROM listen_audio WHERE status IN ('running', 'upgrading', 'queued', 'failed'))
        WHERE item_id IS ?1 AND voice = ?2 AND status IN ('queued', 'upgrading')`,
    ).bind(itemId, body.voice).run();
    // Every paragraph moved is a Listen write, so it counts against Listen's daily share (lib/listen/limits.ts).
    await spend(c.env, (result.meta?.changes ?? 0) * ROW_COST);
    return c.json({ ok: (result.meta?.changes ?? 0) > 0 });
  }
  return c.json({ error: "invalid work" }, 400);
});

app.post("/api/connect", async (c) => {
  const jwt = c.req.header("cf-access-jwt-assertion");
  const email = accessEmail(jwt);
  if (!email && (c.env.ALLOW_UNAUTHENTICATED !== "true" || c.req.header("cf-access-client-id") || jwt)) {
    return c.json({ error: "person_required" }, 403);
  }
  const link = connectLink({
    PROCESSOR_KEY: c.env.PROCESSOR_KEY,
    PROCESSOR_ACCESS_CLIENT_ID: c.env.PROCESSOR_ACCESS_CLIENT_ID,
    PROCESSOR_ACCESS_CLIENT_SECRET: c.env.PROCESSOR_ACCESS_CLIENT_SECRET,
  });
  if (!link) {
    return c.json({ error: "connect_not_configured" }, 503);
  }
  c.header("Cache-Control", "no-store");
  return c.json({ link });
});

// The desktop window's sign-in through the person's usual browser. Access has
// already signed this request in, so the page hands its session token to the
// one-shot listener the desktop app opened on 127.0.0.1, by a form post, which
// keeps the token out of the address bar, the history and every log. Only a
// person's session is handed over, never a service token's, and only to a
// loopback port carrying the state the desktop app chose.
const DESKTOP_STATE = /^[A-Za-z0-9_-]{16,128}$/;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function desktopAuthPage(token: string, port: number, state: string, nonce: string): string {
  const action = `http://127.0.0.1:${port}/auth-callback`;
  return `<!doctype html>
<html lang="en-GB">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signing in to Study Library</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem;color:#1c1917;background:#f6f5f3}</style>
<form id="handoff" method="post" action="${escapeHtml(action)}">
<input type="hidden" name="cf_auth" value="${escapeHtml(token)}">
<input type="hidden" name="state" value="${escapeHtml(state)}">
<p>Signing the Study Library window in with this browser's session.</p>
<noscript><p><button type="submit">Sign the window in</button></p></noscript>
</form>
<script nonce="${nonce}">document.getElementById("handoff").submit();</script>
</html>`;
}

app.get("/api/desktop-auth", (c) => {
  const jwt = c.req.header("cf-access-jwt-assertion");
  const token = getCookie(c, "CF_Authorization") || jwt;
  if (!token || !accessEmail(jwt)) return c.json({ error: "person_required" }, 403);
  const portText = c.req.query("port") ?? "";
  const port = Number(portText);
  const state = c.req.query("state") ?? "";
  if (!/^\d{4,5}$/.test(portText) || port < 1024 || port > 65535 || !DESKTOP_STATE.test(state)) {
    return c.json({ error: "bad_request" }, 400);
  }
  const nonce = crypto.randomUUID().replace(/-/g, "");
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action http://127.0.0.1:${port}; frame-ancestors 'none'; base-uri 'none'`,
  );
  return c.html(desktopAuthPage(token, port, state, nonce));
});

app.post("/api/sync/push", async (c) => {
  const { changes } = await c.req.json<{ changes: Change[] }>();
  return c.json(await push(c.env, changes));
});

app.get("/api/sync/pull", async (c) => {
  const since = Number(c.req.query("since") ?? 0) || 0;
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 2000) || 2000, 1), 2000);
  return c.json(await pull(c.env, since, limit));
});

app.put("/api/files/:sha", async (c) => {
  try {
    return c.json(await storeUpload(c.env, c.req.raw, c.req.param("sha")));
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

app.put("/api/pictures/:filename", async (c) => {
  try {
    return c.json(await storePicture(c.env, c.req.raw, c.req.param("filename")));
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

app.get("/api/pictures/:filename", (c) => servePicture(c.env, c.req.param("filename"), c.req.raw));

// Kokoro's model, fetched from Hugging Face by the Worker so the browser never needs CORS (models.ts).
app.get("/api/models/*", (c) => serveModelFile(c.env, c.req.path.replace(/^\/api\/models\//, ""), c.req.raw));

app.get("/api/objects/*", (c) => serveObject(c.env, c.req.path.replace(/^\/api\/objects\//, ""), c.req.raw));

app.post("/api/uploads", async (c) => {
  const { sha256, mime } = await c.req.json<{ sha256: string; mime: string }>();
  try {
    return c.json(await startUpload(c.env, sha256, mime));
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

app.put("/api/uploads/:uploadId/:part", async (c) => {
  return c.json(await uploadPart(c.env, c.req.query("key") ?? "", c.req.param("uploadId"), Number(c.req.param("part")), c.req.raw));
});

app.post("/api/uploads/:uploadId/complete", async (c) => {
  const { key, parts } = await c.req.json<{ key: string; parts: { part_number: number; etag: string }[] }>();
  return c.json(await completeUpload(c.env, key, c.req.param("uploadId"), parts.map((p) => ({ partNumber: p.part_number, etag: p.etag }))));
});

app.put("/api/recordings/:id/chunks/:index", async (c) => {
  try {
    return c.json(await storeChunk(c.env, c.req.param("id"), Number(c.req.param("index")), c.req.raw));
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

app.post("/api/recordings/:id/retry", async (c) => c.json({ ok: await retryRecording(c.env, c.req.param("id")) }));

// Transcribes a prepared recording when asked, which is when its cost is incurred.
app.post("/api/recordings/:id/transcribe", async (c) => c.json({ ok: await transcribeRecording(c.env, c.req.param("id")) }));

// Looks again at a reading's first pages for its citation.
app.post("/api/files/:id/identify", async (c) => {
  await c.env.DB.prepare("INSERT INTO jobs (type, payload, priority) VALUES ('identify', json_object('file_id', ?1), 0)")
    .bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

app.get("/api/search", async (c) => c.json(await search(c.env, c.req.query("q") ?? "", Number(c.req.query("limit")) || 40)));

// Fetches a Google Calendar secret iCal feed for the browser, which cannot read it
// directly. The body is { url }, and calendarProxy.ts checks it before any request.
app.post("/api/calendar/ics", async (c) => {
  const body = await c.req.json<{ url?: unknown }>().catch(() => null);
  if (typeof body?.url !== "string") return c.json({ error: "bad_url" }, 400);
  return proxyIcsFeed(c.env, body.url);
});

app.post("/api/files/:id/bump", async (c) => {
  await bumpFile(c.env, c.req.param("id"));
  return c.json({ ok: true });
});

// Reads every scan again with the current OCR. Settings offers it.
app.post("/api/rescan", async (c) => c.json({ queued: await queueRescan(c.env) }));

// Queues thumbnail generation for every file that lacks one, or with
// ?covers=1 draws every reading's cover again, cropped. Non-destructive.
app.post("/api/thumbs", async (c) => c.json({ queued: await queueThumbs(c.env, c.req.query("covers") === "1") }));

app.post("/api/files/:id/retry", async (c) => {
  return c.json({ ok: await retryFile(c.env, c.req.param("id")) });
});

app.route("/api/processor/listen", listenProcessor);
// Runs one step of a file's processing again: its OCR, its cover or its citation.
// A missing or unreadable body is answered as a bad step rather than a crash.
app.post("/api/files/:id/redo", async (c) => {
  const body = await c.req.json<{ step?: unknown }>().catch(() => null);
  const step = REDO_STEPS.find((s) => s === body?.step);
  if (!step) return c.json({ error: "invalid step" }, 400);
  return c.json({ ok: await redoFile(c.env, c.req.param("id"), step) });
});

app.route("/api/processor", processor);
app.route("/api/listen", listen);

// Wipes everything. Only for local tests, and only when DEV_RESET is set.
app.post("/api/dev/reset", async (c) => {
  if (c.env.DEV_RESET !== "true") return c.json({ error: "not available" }, 404);
  await c.env.DB.batch([
    ...TABLE_NAMES.map((t) => c.env.DB.prepare(`DELETE FROM ${t}`)),
    c.env.DB.prepare("DELETE FROM jobs"),
    c.env.DB.prepare("DELETE FROM page_text"),
    c.env.DB.prepare("DELETE FROM transcript_text"),
    c.env.DB.prepare("DELETE FROM listen_audio"),
    c.env.DB.prepare("DELETE FROM counters WHERE name = 'listen_gpu_seen' OR name = 'listen_audio_bytes' OR name LIKE 'listen_writes:%'"),
    c.env.DB.prepare("UPDATE counters SET value = 0 WHERE name = 'seq'"),
  ]);
  let cursor: string | undefined;
  do {
    const listed = await c.env.BUCKET.list({ cursor });
    if (listed.objects.length) await c.env.BUCKET.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return c.json({ ok: true });
});

// Runs the nightly purge now. Only for local tests, and only when DEV_RESET is set.
app.post("/api/dev/purge", async (c) => {
  if (c.env.DEV_RESET !== "true") return c.json({ error: "not available" }, 404);
  await purge(c.env);
  return c.json({ ok: true });
});

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(maintain(env, new Date(event.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
