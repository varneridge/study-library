import { TOUCH, type Env } from "./env";
import { TABLE_NAMES } from "./schema";

const TOMBSTONE_DAYS = 90;
const STALE_MINUTES = 60;
// A file no reading or recording has pointed at for this long is let go. The
// wait covers a device that uploaded a file but has not yet sent its reading.
const UNUSED_DAYS = 30;

// Runs every 15 minutes. Purging only happens in the 03:00 UTC run.
export async function maintain(env: Env, at: Date): Promise<void> {
  await env.DB.prepare(
    `UPDATE jobs SET status = 'queued'
      WHERE status = 'running'
        AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${STALE_MINUTES} minutes')`,
  ).run();

  if (at.getUTCHours() === 3 && at.getUTCMinutes() < 15) await purge(env);
}

export async function purge(env: Env): Promise<void> {
  const cutoff = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${TOMBSTONE_DAYS} days')`;
  const orphaned = await env.DB.prepare(
    `SELECT DISTINCT f.r2_key FROM files f
      WHERE f.deleted = 1 AND f.modified_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM files o WHERE o.r2_key = f.r2_key AND o.id <> f.id AND o.deleted = 0)
        AND NOT EXISTS (SELECT 1 FROM applications a WHERE f.r2_key IN (
          json_extract(a.file_cv, '$.key'), json_extract(a.file_cl, '$.key'),
          json_extract(a.file_rd, '$.key'), json_extract(a.file_qs, '$.key')))`,
  ).all<{ r2_key: string }>();

  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM page_text WHERE file_id IN (SELECT id FROM files WHERE deleted = 1 AND modified_at < ${cutoff})`,
    ),
    ...TABLE_NAMES.map((table) => env.DB.prepare(`DELETE FROM ${table} WHERE deleted = 1 AND modified_at < ${cutoff}`)),
    env.DB.prepare(
      `DELETE FROM jobs WHERE status = 'done' AND finished_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')`,
    ),
    // Search text for files and recordings that no longer exist.
    env.DB.prepare("DELETE FROM page_text WHERE file_id NOT IN (SELECT id FROM files)"),
    env.DB.prepare("DELETE FROM transcript_text WHERE recording_id NOT IN (SELECT id FROM recordings)"),
  ]);
  await releaseUnusedFiles(env);

  for (const row of orphaned.results ?? []) await env.BUCKET.delete(row.r2_key);
}

// Deleting a reading or a recording leaves its file row alone, so restoring
// brings the file back. Once nothing points at a file, not even a deleted
// row waiting to be purged, it is marked deleted and goes in a later purge.
// Pictures in notes have no file row, so they are never touched here.
export async function releaseUnusedFiles(env: Env): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE files SET deleted = 1, ${TOUCH}
      WHERE deleted = 0
        AND modified_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${UNUSED_DAYS} days')
        AND NOT EXISTS (SELECT 1 FROM items i WHERE i.file_id = files.id OR i.original_file_id = files.id)
        AND NOT EXISTS (SELECT 1 FROM recordings r WHERE r.file_id = files.id)`,
  ).run();
  return result.meta?.changes ?? 0;
}
