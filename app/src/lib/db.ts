import Dexie, { type Table } from "dexie";
import type { TableName, Tables } from "./types";

export interface OutboxEntry {
  seq?: number;
  table: TableName;
  row: Tables[TableName];
  // The columns this edit changed. Missing for a new row, which is sent whole.
  cols?: string[];
}

export interface FailedChange {
  id?: number;
  table: string;
  row_id: string;
  error: string;
  at: string;
}

export interface MetaEntry {
  key: string;
  value: unknown;
}

export interface CachedBlob {
  file_id: string;
  r2_key: string;
  blob: Blob;
  bytes: number;
  cached_at: string;
}

// A file waiting to upload. The blob is kept here so uploads survive a reload.
// It belongs to either a reading (item_id) or a recording (recording_id).
export interface PendingUpload {
  id: string;
  file_id: string;
  item_id: string;
  recording_id?: string;
  // Large files upload in parts. Finished parts are remembered here.
  multipart?: { key: string; upload_id: string; parts: { part_number: number; etag: string }[] };
  name: string;
  mime: string;
  sha256: string;
  bytes: number;
  blob: Blob;
  status: "queued" | "uploading" | "failed";
  attempts: number;
  error: string | null;
  created_at: string;
}

// A piece of a live recording, kept until the server confirms it.
export interface RecordingChunk {
  id?: number;
  recording_id: string;
  index: number;
  mime: string;
  blob: Blob;
}

class StudyDB extends Dexie {
  modules!: Table<Tables["modules"], string>;
  weeks!: Table<Tables["weeks"], string>;
  sessions!: Table<Tables["sessions"], string>;
  files!: Table<Tables["files"], string>;
  items!: Table<Tables["items"], string>;
  week_items!: Table<Tables["week_items"], string>;
  questions!: Table<Tables["questions"], string>;
  highlights!: Table<Tables["highlights"], string>;
  recordings!: Table<Tables["recordings"], string>;
  notes!: Table<Tables["notes"], string>;
  note_blocks!: Table<Tables["note_blocks"], string>;
  settings!: Table<Tables["settings"], string>;
  applications!: Table<Tables["applications"], string>;
  outbox!: Table<OutboxEntry, number>;
  failed!: Table<FailedChange, number>;
  meta!: Table<MetaEntry, string>;
  blobs!: Table<CachedBlob, string>;
  uploads!: Table<PendingUpload, string>;
  chunks!: Table<RecordingChunk, number>;

  constructor() {
    super("study-library");
    this.version(1).stores({
      modules: "id",
      weeks: "id, module_id",
      sessions: "id, week_id",
      files: "id, sha256",
      items: "id, file_id, tray_module_id, zotero_key",
      week_items: "id, week_id, item_id",
      questions: "id, session_id",
      highlights: "id, item_id",
      recordings: "id, session_id",
      notes: "id, session_id, item_id, question_id",
      note_blocks: "id, note_id",
      outbox: "++seq, row.id",
      failed: "++id",
      meta: "key",
      blobs: "file_id",
      uploads: "id, item_id, status",
    });
    this.version(2).stores({
      highlights: "id, item_id, question_id",
      chunks: "++id, recording_id",
      transcripts: "recording_id",
      uploads: "id, item_id, recording_id, status",
    });
    this.version(3).stores({
      items: "id, file_id, tray_module_id, zotero_key, last_opened_at",
      settings: "id",
    });
    // Transcripts now live on the recording row, so the old cache goes.
    this.version(4).stores({ transcripts: null });
    // The job search, from 0.23.
    this.version(5).stores({ applications: "id" });
    // A dissertation section's own notes, from 0.31.
    this.version(6).stores({ notes: "id, session_id, item_id, question_id, week_id" });
  }
}

export const db = new StudyDB();

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const entry = await db.meta.get(key);
  return entry?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}
