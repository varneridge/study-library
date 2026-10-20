// Columns each synced table accepts from devices. seq is never accepted:
// triggers set it. Anything not listed here is ignored.

interface TableSpec {
  columns: readonly string[];
  json: readonly string[];
  bool: readonly string[];
}

// Used when a new row leaves out a column that cannot be empty.
const DEFAULTS: Record<string, unknown> = {
  deleted: false,
  is_reading_week: false,
  read_status: "unread",
  text_status: "pending",
  session_pattern: ["lecture", "seminar"],
  status: "recording",
  employer: "",
  role: "",
  stage: "applied",
  kind: "change",
};

const BASE = ["id", "modified_at", "deleted"] as const;

function spec(columns: string[], json: string[] = [], bool: string[] = []): TableSpec {
  return { columns: [...BASE, ...columns], json, bool: ["deleted", ...bool] };
}

export const TABLES = {
  modules: spec(
    ["code", "title", "session_pattern", "description", "last_opened_week_id", "position", "kind", "key_dates"],
    ["session_pattern", "description", "key_dates"],
  ),
  weeks: spec(["module_id", "term", "number", "title", "is_reading_week"], [], ["is_reading_week"]),
  sessions: spec(["week_id", "kind", "title", "position"]),
  files: spec(["sha256", "r2_key", "mime", "bytes", "original_name", "page_count", "text_status"]),
  items: spec([
    "kind", "author", "title", "source", "pages", "year", "doc_date", "file_id",
    "original_file_id", "tray_module_id", "zotero_key", "last_page", "read_status", "last_opened_at", "suggested", "last_spot",
  ], ["suggested", "last_spot"]),
  week_items: spec(["week_id", "item_id", "session_id", "position"]),
  questions: spec(["session_id", "body", "position"]),
  // The job search. The four file slots are JSON, one column each, so an
  // edit to one slot never touches another.
  applications: spec(
    ["employer", "role", "applied", "stage", "next_deadline", "notes", "file_cv", "file_cl", "file_rd", "file_qs"],
    ["file_cv", "file_cl", "file_rd", "file_qs"],
  ),
  application_events: spec(
    ["application_id", "stage", "from_stage", "at", "kind", "cleared_deadline"],
  ),
  highlights: spec(
    ["item_id", "page", "rects", "body", "colour", "comment", "question_id", "zotero_key"],
    ["rects"],
  ),
  recordings: spec(
    ["session_id", "source", "file_id", "duration_seconds", "status", "turns"],
    ["turns"],
  ),
  notes: spec(["session_id", "item_id", "question_id", "week_id", "zotero_key"]),
  note_blocks: spec(
    ["note_id", "position", "type", "content", "highlight_id"],
    ["content"],
  ),
  settings: spec(["value"], ["value"]),
} satisfies Record<string, TableSpec>;

export type TableName = keyof typeof TABLES;
export const TABLE_NAMES = Object.keys(TABLES) as TableName[];

export function isTable(name: unknown): name is TableName {
  return typeof name === "string" && Object.hasOwn(TABLES, name);
}

type Value = string | number | null;

export function encode(table: TableName, column: string, value: unknown): Value {
  const t = TABLES[table];
  if (value === undefined && column in DEFAULTS) value = DEFAULTS[column];
  if (value === undefined || value === null) return null;
  if (t.json.includes(column)) return JSON.stringify(value);
  if (t.bool.includes(column)) return value ? 1 : 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  return JSON.stringify(value);
}

export function decode(table: TableName, row: Record<string, unknown>): Record<string, unknown> {
  const t = TABLES[table];
  const out: Record<string, unknown> = { ...row };
  for (const column of t.json) {
    const raw = out[column];
    if (typeof raw === "string") {
      try {
        out[column] = JSON.parse(raw);
      } catch {
        out[column] = null;
      }
    }
  }
  for (const column of t.bool) out[column] = Boolean(out[column]);
  return out;
}
