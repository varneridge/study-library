// Endpoints used by the processor, which runs the OCR and conversion tools.
import { Hono } from "hono";
import { requireProcessor } from "./auth";
import { NOW, TOUCH, type Env } from "./env";
import { serveObject, queueRescan } from "./files";
import { listChunks } from "./recordings";
import { decode } from "./schema";

const MAX_ATTEMPTS = 5;

export const processor = new Hono<{ Bindings: Env }>();
processor.use("*", requireProcessor);

// The same rescan, from the laptop: python -m study.processor --rescan
processor.post("/rescan", async (c) => c.json({ queued: await queueRescan(c.env) }));

processor.post("/claim", async (c) => {
  // The app shows when the processor last asked for work.
  await c.env.DB.prepare(
    `INSERT INTO counters (name, value) VALUES ('processor_seen', CAST(strftime('%s', 'now') AS INTEGER))
     ON CONFLICT (name) DO UPDATE SET value = excluded.value`,
  ).run();
  const job = await c.env.DB.prepare(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ${NOW}
      WHERE id = (
        SELECT id FROM jobs
         WHERE status = 'queued' AND run_after <= ${NOW}
         ORDER BY priority IS NULL, priority, id
         LIMIT 1)
      RETURNING id, type, payload, attempts, priority`,
  ).first<{ id: number; type: string; payload: string; attempts: number; priority: number | null }>();
  if (!job) return c.json({ job: null });
  return c.json({ job: { ...job, payload: JSON.parse(job.payload || "{}") } });
});

processor.post("/jobs/:id/complete", async (c) => {
  await c.env.DB.prepare(
    `UPDATE jobs SET status = 'done', finished_at = ${NOW}, error = NULL WHERE id = ?1`,
  ).bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// A long job reports in while it runs, so the stale-job sweep leaves it alone.
processor.post("/jobs/:id/heartbeat", async (c) => {
  const result = await c.env.DB.prepare(`UPDATE jobs SET started_at = ${NOW} WHERE id = ?1 AND status = 'running'`)
    .bind(Number(c.req.param("id"))).run();
  return c.json({ running: (result.meta?.changes ?? 0) > 0 });
});

processor.post("/jobs/:id/fail", async (c) => {
  const id = Number(c.req.param("id"));
  const { error } = await c.req.json<{ error: string }>();
  const job = await c.env.DB.prepare("SELECT attempts FROM jobs WHERE id = ?1").bind(id).first<{ attempts: number }>();
  if (!job) return c.json({ error: "no such job" }, 404);
  const final = job.attempts >= MAX_ATTEMPTS;
  if (final) {
    await c.env.DB.prepare(
      `UPDATE jobs SET status = 'failed', finished_at = ${NOW}, error = ?2 WHERE id = ?1`,
    ).bind(id, String(error).slice(0, 4000)).run();
  } else {
    const minutes = 2 ** job.attempts;
    await c.env.DB.prepare(
      `UPDATE jobs SET status = 'queued', error = ?2,
         run_after = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ?3 || ' minutes')
       WHERE id = ?1`,
    ).bind(id, String(error).slice(0, 4000), minutes).run();
  }
  return c.json({ final });
});

processor.post("/jobs", async (c) => {
  const { type, payload, priority } = await c.req.json<{ type: string; payload: unknown; priority?: number | null }>();
  await c.env.DB.prepare("INSERT INTO jobs (type, payload, priority) VALUES (?1, ?2, ?3)")
    .bind(type, JSON.stringify(payload ?? {}), priority ?? null)
    .run();
  return c.json({ ok: true });
});

processor.get("/files/:id", async (c) => {
  const file = await c.env.DB.prepare("SELECT * FROM files WHERE id = ?1").bind(c.req.param("id")).first();
  if (!file) return c.json({ error: "no such file" }, 404);
  return c.json({ file: { ...file, deleted: Boolean(file.deleted) } });
});

processor.get("/objects/*", (c) => serveObject(c.env, c.req.path.replace(/^.*\/objects\//, ""), c.req.raw));

processor.put("/objects/*", async (c) => {
  const key = c.req.path.replace(/^.*\/objects\//, "");
  if (!key.startsWith("files/")) return c.json({ error: "keys must start with files/" }, 400);
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "empty upload" }, 400);
  await c.env.BUCKET.put(key, body, {
    httpMetadata: { contentType: c.req.header("content-type") ?? "application/octet-stream" },
  });
  return c.json({ key });
});

processor.delete("/objects/*", async (c) => {
  const key = c.req.path.replace(/^.*\/objects\//, "");
  if (c.req.query("if_unreferenced")) {
    const used = await c.env.DB.prepare("SELECT 1 FROM files WHERE r2_key = ?1 AND deleted = 0 LIMIT 1").bind(key).first();
    if (used) return c.json({ deleted: false });
  }
  await c.env.BUCKET.delete(key);
  return c.json({ deleted: true });
});

// Stores extracted text for search and marks the file ready.
// A citation the processor found for a PDF. Readings with nothing to go on
// take it at once. Others keep what they have, with this as a suggestion.
interface Citation {
  work_kind?: string | null;
  author: string | null;
  editor?: string | null;
  year: number | null;
  title: string;
  source: string | null;
  publisher?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages: string | null;
  doc_date?: string | null;
  doi?: string | null;
}
const same = (a: unknown, b: unknown) => String(a ?? "").toLowerCase().replace(/[^a-z0-9]/g, "") === String(b ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

processor.post("/files/:id/identified", async (c) => {
  const id = c.req.param("id");
  const { citation, via } = await c.req.json<{ citation: Citation; via: string }>();
  if (!citation?.title) return c.json({ error: "a citation needs a title" }, 400);
  const items = (await c.env.DB.prepare("SELECT * FROM items WHERE file_id = ?1 AND deleted = 0").bind(id).all()).results ?? [];
  const statements: D1PreparedStatement[] = [];
  let applied = 0;
  let suggested = 0;
  for (const raw of items) {
    const item = decode("items", raw) as Record<string, unknown> & { suggested?: Record<string, unknown> | null };
    if (item.kind === "slides") continue;
    const fields = ["author", "year", "title", "source", "pages"] as const;
    const allFields = ["work_kind", "author", "editor", "year", "title", "source", "publisher", "volume", "issue", "pages", "doc_date", "doi"] as const;
    if (fields.every((f) => same(item[f], citation[f]))) continue;
    // The same suggestion, already dismissed, is not raised again.
    const previous = item.suggested;
    if (previous?.dismissed && fields.every((f) => same(previous[f], citation[f]))) continue;
    // Only records that state their citation outright fill a reading in by themselves.
    const unnamed = item.kind === "secondary" && !item.author && !item.year && ["crossref", "crossref-title", "jstor"].includes(via);
    if (unnamed) {
      const before = Object.fromEntries(allFields.map((f) => [f, item[f] ?? null]));
      statements.push(c.env.DB.prepare(
        `UPDATE items SET work_kind = ?2, author = ?3, editor = ?4, year = ?5, title = ?6, source = ?7, publisher = ?8, volume = ?9, issue = ?10, pages = ?11, doc_date = ?12, doi = ?13, suggested = ?14, ${TOUCH} WHERE id = ?1`,
      ).bind(
        item.id,
        citation.work_kind ?? null,
        citation.author ?? null,
        citation.editor ?? null,
        citation.year ?? null,
        citation.title,
        citation.source ?? null,
        citation.publisher ?? null,
        citation.volume ?? null,
        citation.issue ?? null,
        citation.pages ?? null,
        citation.doc_date ?? null,
        citation.doi ?? null,
        JSON.stringify({ ...citation, via, applied: true, previous: before }),
      ));
      applied += 1;
    } else {
      statements.push(c.env.DB.prepare(`UPDATE items SET suggested = ?2, ${TOUCH} WHERE id = ?1`)
        .bind(item.id, JSON.stringify({ ...citation, via, applied: false })));
      suggested += 1;
    }
  }
  if (statements.length) await c.env.DB.batch(statements);
  return c.json({ applied, suggested });
});

processor.post("/files/:id/text", async (c) => {
  const id = c.req.param("id");
  const { page_count, pages } = await c.req.json<{ page_count: number; pages: { page: number; body: string }[] }>();
  const statements = [c.env.DB.prepare("DELETE FROM page_text WHERE file_id = ?1").bind(id)];
  for (const page of pages) {
    if (page.body.trim()) {
      statements.push(
        c.env.DB.prepare("INSERT INTO page_text (body, file_id, page) VALUES (?1, ?2, ?3)").bind(page.body, id, page.page),
      );
    }
  }
  statements.push(
    c.env.DB.prepare(`UPDATE files SET text_status = 'ready', page_count = ?2, ${TOUCH} WHERE id = ?1`).bind(id, page_count),
  );
  await c.env.DB.batch(statements);
  return c.json({ ok: true });
});

processor.post("/files/:id/needs-ocr", async (c) => {
  const id = c.req.param("id");
  // mode: "redo" reads the text again and leaves the pages as they are;
  // "fresh" rebuilds the file from its page images with the full treatment.
  // Without one, only the pages with no text are read. redo is the old name.
  const { page_count, priority, redo, mode } = await c.req.json<{ page_count: number; priority: number | null; redo?: boolean; mode?: string }>();
  const how = mode === "fresh" || mode === "redo" ? mode : redo ? "redo" : "skip";
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE files SET text_status = 'ocr', page_count = ?2, ${TOUCH} WHERE id = ?1`).bind(id, page_count),
    c.env.DB.prepare("INSERT INTO jobs (type, payload, priority) VALUES ('ocr', json_object('file_id', ?1, 'mode', ?3, 'redo', json(?4)), ?2)")
      .bind(id, priority, how, how === "redo" ? "true" : "false"),
  ]);
  return c.json({ ok: true });
});

// After OCR the file points at the new object and is read again.
processor.post("/files/:id/replaced", async (c) => {
  const id = c.req.param("id");
  const { r2_key, bytes, priority } = await c.req.json<{ r2_key: string; bytes: number; priority: number | null }>();
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE files SET r2_key = ?2, bytes = ?3, text_status = 'pending', ${TOUCH} WHERE id = ?1`).bind(id, r2_key, bytes),
    c.env.DB.prepare(
      "INSERT INTO jobs (type, payload, priority) VALUES ('extract_text', json_object('file_id', ?1, 'after_ocr', json('true')), ?2)",
    ).bind(id, priority),
  ]);
  return c.json({ ok: true });
});

// A converted PDF becomes the file every item reads. The original is kept.
processor.post("/files/:id/converted", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ sha256: string; r2_key: string; bytes: number; original_name: string }>();
  const pdfId = `${id}:pdf`;
  await c.env.DB.batch([
    // The insert trigger queues extract_text for the new PDF.
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO files (id, sha256, r2_key, mime, bytes, original_name, text_status, modified_at)
       VALUES (?1, ?2, ?3, 'application/pdf', ?4, ?5, 'pending', ${NOW})`,
    ).bind(pdfId, body.sha256, body.r2_key, body.bytes, body.original_name),
    c.env.DB.prepare(
      `UPDATE items SET original_file_id = file_id, file_id = ?2, ${TOUCH} WHERE file_id = ?1 AND deleted = 0`,
    ).bind(id, pdfId),
    c.env.DB.prepare(`UPDATE files SET text_status = 'converted', ${TOUCH} WHERE id = ?1`).bind(id),
  ]);
  return c.json({ file_id: pdfId });
});

processor.post("/files/:id/failed", async (c) => {
  await c.env.DB.prepare(`UPDATE files SET text_status = 'failed', ${TOUCH} WHERE id = ?1`).bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// Recordings

processor.get("/recordings/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT * FROM recordings WHERE id = ?1").bind(id).first();
  if (!row) return c.json({ error: "no such recording" }, 404);
  const recording = decode("recordings", row);
  const file = recording.file_id
    ? await c.env.DB.prepare("SELECT * FROM files WHERE id = ?1").bind(recording.file_id).first()
    : null;
  return c.json({ recording, file, chunks: await listChunks(c.env, id), context: await contextFor(c.env, String(recording.session_id)) });
});

// What a recording is about, so the transcriber can expect the right names:
// the module, the week, and the authors and titles of that week's readings.
async function contextFor(env: Env, sessionId: string): Promise<{ prompt: string; keywords: string[] }> {
  const place = await env.DB.prepare(
    `SELECT s.kind, s.title AS session_title, w.id AS week_id, w.title AS week_title, m.code, m.title AS module_title
       FROM sessions s JOIN weeks w ON w.id = s.week_id JOIN modules m ON m.id = w.module_id WHERE s.id = ?1`,
  ).bind(sessionId).first<{ kind: string; session_title: string | null; week_id: string; week_title: string | null; code: string; module_title: string | null }>();
  if (!place) return { prompt: "", keywords: [] };
  const readings = (await env.DB.prepare(
    `SELECT i.author, i.title FROM week_items l JOIN items i ON i.id = l.item_id
      WHERE l.week_id = ?1 AND l.deleted = 0 AND i.deleted = 0 LIMIT 40`,
  ).bind(place.week_id).all<{ author: string | null; title: string }>()).results ?? [];
  const clean = (t: string) => t.replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim();
  const keywords = new Set<string>();
  for (const r of readings) {
    for (const name of (r.author ?? "").split(/,| and /)) {
      const surname = name.trim();
      if (surname.length > 2 && /^[A-Z\u00C0-\u024F]/.test(surname) && !/\./.test(surname)) keywords.add(clean(surname));
    }
    if (r.title) keywords.add(clean(r.title).slice(0, 80));
  }
  const session = place.session_title || (place.kind === "seminar" ? "seminar" : "lecture");
  const prompt = clean(`A university ${session} for ${place.code}${place.module_title ? `, ${place.module_title}` : ""}${place.week_title ? `, on ${place.week_title}` : ""}. British English.`);
  return { prompt, keywords: [...keywords].slice(0, 40) };
}

processor.post("/recordings/:id/status", async (c) => {
  const { status } = await c.req.json<{ status: string }>();
  await c.env.DB.prepare(`UPDATE recordings SET status = ?2, ${TOUCH} WHERE id = ?1`).bind(c.req.param("id"), status).run();
  return c.json({ ok: true });
});

// The processed audio replaces the chunks or the uploaded original.
processor.post("/recordings/:id/audio", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ r2_key: string; bytes: number; duration: number; mime: string; delete_source: boolean }>();
  const recording = await c.env.DB.prepare("SELECT file_id FROM recordings WHERE id = ?1").bind(id).first<{ file_id: string | null }>();
  if (!recording) return c.json({ error: "no such recording" }, 404);
  const audioId = `${id}:audio`;
  const source = recording.file_id && recording.file_id !== audioId
    ? await c.env.DB.prepare("SELECT id, r2_key FROM files WHERE id = ?1").bind(recording.file_id).first<{ id: string; r2_key: string }>()
    : null;

  const statements = [
    c.env.DB.prepare(
      `INSERT INTO files (id, sha256, r2_key, mime, bytes, original_name, text_status, modified_at)
       VALUES (?1, '', ?2, ?3, ?4, 'recording', 'ready', ${NOW})
       ON CONFLICT (id) DO UPDATE SET r2_key = excluded.r2_key, mime = excluded.mime, bytes = excluded.bytes, ${TOUCH}`,
    ).bind(audioId, body.r2_key, body.mime, body.bytes),
    c.env.DB.prepare(
      `UPDATE recordings SET file_id = ?2, duration_seconds = ?3, status = 'transcribing', ${TOUCH} WHERE id = ?1`,
    ).bind(id, audioId, body.duration),
    c.env.DB.prepare("INSERT INTO jobs (type, payload, priority) VALUES ('transcribe', json_object('recording_id', ?1), -1)").bind(id),
  ];
  if (source && body.delete_source) {
    statements.push(c.env.DB.prepare(`UPDATE files SET deleted = 1, ${TOUCH} WHERE id = ?1`).bind(source.id));
  }
  await c.env.DB.batch(statements);

  const chunks = await listChunks(c.env, id);
  if (chunks.length) await c.env.BUCKET.delete(chunks);
  if (source && body.delete_source) {
    const used = await c.env.DB.prepare("SELECT 1 FROM files WHERE r2_key = ?1 AND deleted = 0 LIMIT 1").bind(source.r2_key).first();
    if (!used) await c.env.BUCKET.delete(source.r2_key);
  }
  return c.json({ file_id: audioId });
});

// A transcript arrives as text, and is kept on the recording as one turn.
// The recording's own trigger indexes it for search.
processor.post("/recordings/:id/transcript", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ text?: string; segments?: { text: string }[] }>();
  // Spaces are tidied, but any line breaks the model gives are kept.
  const text = (body.text ?? (body.segments ?? []).map((s) => s.text.trim()).join(" "))
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  await c.env.DB.prepare(`UPDATE recordings SET turns = ?2, status = 'done', ${TOUCH} WHERE id = ?1`)
    .bind(id, JSON.stringify(text ? [{ speaker: "", text }] : []))
    .run();
  return c.json({ ok: true });
});
