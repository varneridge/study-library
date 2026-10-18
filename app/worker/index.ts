import { Hono } from "hono";
import { requireAccess } from "./auth";
import type { Env } from "./env";
import { bumpFile, completeUpload, retryFile, serveObject, startUpload, storeUpload, uploadPart, queueRescan } from "./files";
import { retryRecording, storeChunk } from "./recordings";
import { search } from "./search";
import { maintain, purge } from "./maintenance";
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

// Looks again at a reading's first pages for its citation.
app.post("/api/files/:id/identify", async (c) => {
  await c.env.DB.prepare("INSERT INTO jobs (type, payload, priority) VALUES ('identify', json_object('file_id', ?1), 0)")
    .bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

app.get("/api/search", async (c) => c.json(await search(c.env, c.req.query("q") ?? "", Number(c.req.query("limit")) || 40)));

app.post("/api/files/:id/bump", async (c) => {
  await bumpFile(c.env, c.req.param("id"));
  return c.json({ ok: true });
});

// Reads every scan again with the current OCR. Settings offers it.
app.post("/api/rescan", async (c) => c.json({ queued: await queueRescan(c.env) }));

app.post("/api/files/:id/retry", async (c) => {
  return c.json({ ok: await retryFile(c.env, c.req.param("id")) });
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
