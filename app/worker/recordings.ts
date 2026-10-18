import { TOUCH, type Env } from "./env";

const CHUNK_TYPES: Record<string, string> = { "audio/webm": "webm", "audio/mp4": "mp4", "audio/ogg": "ogg" };

export function chunkPrefix(recordingId: string): string {
  return `recordings/${recordingId}/chunk-`;
}

// Live recordings arrive as numbered chunks. Storing the same chunk twice is harmless.
export async function storeChunk(env: Env, recordingId: string, index: number, request: Request) {
  const mime = (request.headers.get("content-type") ?? "").split(";")[0].trim();
  const extension = CHUNK_TYPES[mime];
  if (!extension) throw new Error(`unsupported chunk type ${mime || "(none)"}`);
  if (!Number.isInteger(index) || index < 0 || index > 99999) throw new Error("bad chunk index");
  if (!request.body) throw new Error("empty chunk");
  const key = `${chunkPrefix(recordingId)}${String(index).padStart(5, "0")}.${extension}`;
  await env.BUCKET.put(key, request.body, { httpMetadata: { contentType: mime } });
  return { key };
}

export async function listChunks(env: Env, recordingId: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.BUCKET.list({ prefix: chunkPrefix(recordingId), cursor });
    keys.push(...listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

// Picks up processing from wherever it stopped.
export async function retryRecording(env: Env, recordingId: string): Promise<boolean> {
  const recording = await env.DB.prepare("SELECT file_id, turns FROM recordings WHERE id = ?1")
    .bind(recordingId).first<{ file_id: string | null; turns: string | null }>();
  if (!recording) return false;
  const audio = recording.file_id
    ? await env.DB.prepare("SELECT id FROM files WHERE id = ?1 AND id LIKE '%:audio'").bind(recording.file_id).first()
    : null;
  const transcribed = Boolean(audio && recording.turns && recording.turns !== "[]");
  if (transcribed) {
    await env.DB.prepare(`UPDATE recordings SET status = 'done', ${TOUCH} WHERE id = ?1`).bind(recordingId).run();
    return true;
  }
  const [type, status] = !audio ? ["prepare_audio", "processing"] : ["transcribe", "transcribing"];
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM jobs WHERE json_extract(payload, '$.recording_id') = ?1 AND status IN ('failed', 'queued')`,
    ).bind(recordingId),
    env.DB.prepare(`UPDATE recordings SET status = ?2, ${TOUCH} WHERE id = ?1`).bind(recordingId, status),
    env.DB.prepare("INSERT INTO jobs (type, payload, priority) VALUES (?1, json_object('recording_id', ?2), -1)").bind(type, recordingId),
  ]);
  return true;
}
