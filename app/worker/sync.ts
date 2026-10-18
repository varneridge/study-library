import type { Env } from "./env";
import { TABLES, TABLE_NAMES, decode, encode, isTable, type TableName } from "./schema";

const MAX_CHANGES = 500;
const MAX_FUTURE_MS = 10 * 60 * 1000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export interface Change {
  table: string;
  row: Record<string, unknown>;
  // The columns the edit changed. Without it the whole row is written, as
  // versions before 0.22 always did.
  cols?: unknown;
}

export interface Failure {
  table: string;
  id: string | null;
  error: string;
}

// Timestamps are compared as text, so they must share one format.
function normaliseStamp(value: unknown): string | null {
  if (typeof value !== "string" || !ISO.test(value)) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  // A device clock far in the future would win every conflict for ever.
  return new Date(Math.min(ms, Date.now() + MAX_FUTURE_MS)).toISOString();
}

// The columns a patch may write: known ones only, never the id.
function patchColumns(table: TableName, cols: unknown): string[] | null {
  if (!Array.isArray(cols)) return null;
  const known = TABLES[table].columns;
  return known.filter((column) => column !== "id" && column !== "modified_at" && cols.includes(column));
}

// A new row is inserted whole. An existing row takes only the columns the
// edit changed, so a stale copy of the other columns never overwrites them.
function statement(env: Env, table: TableName, row: Record<string, unknown>, patch: string[] | null): D1PreparedStatement {
  // Only the columns the device sent. A device from before a column was
  // added leaves it out: a new row takes the column's default, an existing
  // one keeps its value.
  const columns = TABLES[table].columns.filter((column) => column === "id" || column === "modified_at" || row[column] !== undefined);
  const values = columns.map((column) => encode(table, column, row[column]));
  const placeholders = columns.map((_, i) => `?${i + 1}`).join(", ");
  const updates = [...(patch ? patch.filter((column) => columns.includes(column)) : columns.filter((column) => column !== "id")), ...(patch ? ["modified_at"] : [])]
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");
  return env.DB.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET ${updates}
     WHERE excluded.modified_at > ${table}.modified_at`,
  ).bind(...values);
}

export interface PushResult {
  failures: Failure[];
  // Rows where the server already held a later edit, as the server has them.
  current: Partial<Record<TableName, Record<string, unknown>[]>>;
}

export async function push(env: Env, changes: Change[]): Promise<PushResult> {
  if (!Array.isArray(changes)) throw new Error("changes must be a list");
  if (changes.length > MAX_CHANGES) throw new Error(`at most ${MAX_CHANGES} changes per request`);

  const failures: Failure[] = [];
  const prepared: { change: Change; table: TableName; stmt: D1PreparedStatement }[] = [];

  for (const change of changes) {
    const id = typeof change?.row?.id === "string" ? change.row.id : null;
    if (!isTable(change?.table)) {
      failures.push({ table: String(change?.table), id, error: "table is not synced" });
      continue;
    }
    const stamp = normaliseStamp(change.row.modified_at);
    if (!id || !stamp) {
      failures.push({ table: change.table, id, error: "row needs an id and an ISO modified_at" });
      continue;
    }
    const row = { ...change.row, modified_at: stamp };
    prepared.push({ change, table: change.table, stmt: statement(env, change.table, row, patchColumns(change.table, change.cols)) });
  }

  const current: PushResult["current"] = {};
  if (prepared.length === 0) return { failures, current };

  // A statement that changed nothing met a later edit already on the server.
  const unchanged: { table: TableName; id: string }[] = [];
  try {
    // A batch runs as one transaction.
    const results = await env.DB.batch(prepared.map((p) => p.stmt));
    results.forEach((result, i) => {
      if ((result.meta?.changes ?? 1) === 0) unchanged.push({ table: prepared[i].table, id: String(prepared[i].change.row.id) });
    });
  } catch {
    // Something in the batch failed. Apply rows one at a time so one bad row
    // is reported without blocking the rest.
    for (const { change, table, stmt } of prepared) {
      try {
        const result = await stmt.run();
        if ((result.meta?.changes ?? 1) === 0) unchanged.push({ table, id: String(change.row.id) });
      } catch (error) {
        failures.push({
          table: change.table,
          id: String(change.row.id),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Send those rows back, so the device shows what the server kept.
  if (unchanged.length) {
    const reads = unchanged.slice(0, 200).map(({ table, id }) => env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?1`).bind(id));
    const rows = await env.DB.batch(reads);
    rows.forEach((result, i) => {
      const found = (result.results ?? [])[0] as Record<string, unknown> | undefined;
      if (found) (current[unchanged[i].table] ??= []).push(decode(unchanged[i].table, found));
    });
  }
  return { failures, current };
}

export interface PullResult {
  cursor: number;
  more: boolean;
  rows: Partial<Record<TableName, Record<string, unknown>[]>>;
}

export async function pull(env: Env, since: number, limit = 2000): Promise<PullResult> {
  const top = (await env.DB.prepare("SELECT value FROM counters WHERE name = 'seq'").first<{ value: number }>())?.value ?? 0;
  if (top <= since) return { cursor: top, more: false, rows: {} };

  // Rows with seq at or below top are committed, because D1 applies writes
  // one at a time and the counter moves inside the same transaction.
  const results = await env.DB.batch(
    TABLE_NAMES.map((t) =>
      env.DB.prepare(`SELECT * FROM ${t} WHERE seq > ?1 AND seq <= ?2 ORDER BY seq LIMIT ?3`).bind(since, top, limit),
    ),
  );

  // A table that returned the full limit may have more rows. Rows are only
  // complete up to the lowest last seq among those tables, so stop there.
  let upper = top;
  const all: { table: TableName; row: Record<string, unknown> }[] = [];
  TABLE_NAMES.forEach((table, index) => {
    const found = (results[index].results ?? []) as Record<string, unknown>[];
    if (found.length === limit) upper = Math.min(upper, found[found.length - 1].seq as number);
    for (const row of found) all.push({ table, row });
  });
  const complete = all
    .filter(({ row }) => (row.seq as number) <= upper)
    .sort((a, b) => (a.row.seq as number) - (b.row.seq as number));
  const kept = complete.slice(0, limit);
  if (complete.length > limit) upper = kept[kept.length - 1].row.seq as number;

  const rows: PullResult["rows"] = {};
  for (const { table, row } of kept) (rows[table] ??= []).push(decode(table, row));
  return { cursor: upper, more: upper < top, rows };
}
