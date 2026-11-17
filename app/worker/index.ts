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
import { processor } from "./processor";
import { TABLE_NAMES } from "./schema";
import { pull, push, type Change } from "./sync";

const app = new Hono<{ Bindings: Env }>();

app.onError((error, c) => c.json({ error: error.message }, 500));

app.use("/api/*", requireAccess);

app.get("/api/ping", (c) => c.json({ ok: true }));

// When the processor last asked for work, and how much is waiting for it.
app.get("/api/status", async (c) => {
  const [seen, jobs] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT value FROM counters WHERE name = 'processor_seen'"),
    c.env.DB.prepare(
      `SELECT SUM(status = 'queued') AS queued, SUM(status = 'running') AS running, SUM(status = 'failed') AS failed FROM jobs`,
    ),
  ]);
  const row = (jobs.results?.[0] ?? {}) as { queued?: number | null; running?: number | null; failed?: number | null };
  const value = (seen.results?.[0] as { value?: number } | undefined)?.value ?? null;
  return c.json({ processor_seen: value, queued: row.queued ?? 0, running: row.running ?? 0, failed: row.failed ?? 0 });
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

// Runs one step of a file's processing again: its OCR, its cover or its citation.
// A missing or unreadable body is answered as a bad step rather than a crash.
app.post("/api/files/:id/redo", async (c) => {
  const body = await c.req.json<{ step?: unknown }>().catch(() => null);
  const step = REDO_STEPS.find((s) => s === body?.step);
  if (!step) return c.json({ error: "invalid step" }, 400);
  return c.json({ ok: await redoFile(c.env, c.req.param("id"), step) });
});

app.route("/api/processor", processor);

// Wipes everything. Only for local tests, and only when DEV_RESET is set.
app.post("/api/dev/reset", async (c) => {
  if (c.env.DEV_RESET !== "true") return c.json({ error: "not available" }, 404);
  await c.env.DB.batch([
    ...TABLE_NAMES.map((t) => c.env.DB.prepare(`DELETE FROM ${t}`)),
    c.env.DB.prepare("DELETE FROM jobs"),
    c.env.DB.prepare("DELETE FROM page_text"),
    c.env.DB.prepare("DELETE FROM transcript_text"),
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
