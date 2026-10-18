// The sync engine.
//
// Every edit is written to IndexedDB and added to an outbox in one
// transaction. The outbox is pushed to the Worker, which keeps the newest
// version of each row. Pulling asks for every row written since a cursor.

import { v7 as uuidv7 } from "uuid";
import { db, getMeta, setMeta } from "./db";
import { SYNCED_TABLES, type TableName, type Tables } from "./types";

const PUSH_BATCH = 200;
const POLL_MS = 30_000;

let lastStamp = 0;

export function newId(): string {
  return uuidv7();
}

// Timestamps never repeat on one device, so two quick edits keep their order.
function stamp(): string {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return new Date(lastStamp).toISOString();
}

// Requests

export class SessionExpired extends Error {}

// Cloudflare Access answers an expired session with a redirect to its
// sign-in page. Fetch cannot follow that, so treat it as a sign-in prompt.
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, { ...init, redirect: "manual", credentials: "same-origin" });
  if (response.type === "opaqueredirect" || response.status === 401) {
    setState({ expired: true });
    throw new SessionExpired("Cloudflare Access session ended");
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${text.slice(0, 300)}`);
  }
  return response;
}

// Writing

type Fresh<T extends TableName> = Omit<Tables[T], "modified_at" | "deleted" | "seq"> & { deleted?: boolean };

export type Change<T extends TableName = TableName> =
  | { table: T; row: Fresh<T> | Tables[T]; patch?: false }
  // Only the fields given, laid over whatever the row holds when the edit
  // is saved. A move uses this, so it cannot write back an older copy of
  // a field that changed a moment before.
  | { table: T; row: Partial<Tables[T]> & { id: string }; patch: true };

// Columns that say when a row was written rather than what it holds.
const BOOKKEEPING = new Set(["modified_at", "seq"]);

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// The columns that differ between the stored row and the new one.
export function changedColumns(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !BOOKKEEPING.has(key) && !same(before[key], after[key]));
}

// Saves rows on the device and queues them for the server. A row that
// already exists is sent as a patch of the columns that changed, so an edit
// to one field never carries stale copies of the others with it.
export async function commit(changes: Change[]): Promise<void> {
  if (changes.length === 0) return;
  const names = Array.from(new Set(changes.map((c) => c.table)));
  let queued = 0;
  await db.transaction("rw", [...names.map((n) => db.table(n)), db.outbox], async () => {
    for (const change of changes) {
      const table = db.table(change.table);
      const before = (await table.get(change.row.id as string)) as Record<string, unknown> | undefined;
      if (change.patch && !before) continue;
      const merged = change.patch ? { ...before, ...change.row } : change.row;
      const row = { ...merged, deleted: (merged as { deleted?: boolean }).deleted ?? false } as Record<string, unknown>;
      delete row.seq;
      const cols = before ? changedColumns(before, row) : undefined;
      if (cols && cols.length === 0) continue;
      row.modified_at = stamp();
      await table.put(row);
      await db.outbox.add({ table: change.table, row: row as unknown as Tables[TableName], cols });
      queued += 1;
    }
  });
  if (queued) scheduleFlush();
}

export async function insert<T extends TableName>(table: T, row: Fresh<T>): Promise<void> {
  await commit([{ table, row }]);
}

export async function update<T extends TableName>(table: T, id: string, changes: Partial<Tables[T]>): Promise<void> {
  await commit([{ table, row: { ...changes, id } as Partial<Tables[T]> & { id: string }, patch: true }] as Change[]);
}

export async function remove(table: TableName, id: string): Promise<void> {
  await commit([{ table, row: { id, deleted: true }, patch: true }]);
}

// State shown in the interface

export type SyncState = { online: boolean; busy: boolean; error: string | null; expired: boolean };
let state: SyncState = {
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  busy: false,
  error: null,
  expired: false,
};
const listeners = new Set<(s: SyncState) => void>();

function setState(next: Partial<SyncState>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener(state));
}

export function subscribeSync(listener: (s: SyncState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

function reportError(error: unknown) {
  if (error instanceof SessionExpired) return;
  setState({ error: error instanceof Error ? error.message : String(error) });
}

// Pushing

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let flushAgain = false;

export function scheduleFlush(delay = 300): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flush(), delay);
}

interface Failure {
  table: string;
  id: string | null;
  error: string;
}

type Rows = Partial<Record<TableName, Tables[TableName][]>>;

// Sends one row straight away, in a way the browser finishes even if the
// tab is closing. Used when an app goes to the background, where a phone
// may end the tab before the usual push. It must be called inside the
// event itself, before anything waits, or a closing tab never sends it.
export function sendNow<T extends TableName>(table: T, row: Tables[T], cols: (keyof Tables[T] & string)[]): void {
  if (!navigator.onLine) return;
  try {
    void fetch("/api/sync/push", {
      method: "POST", keepalive: true, credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ changes: [{ table, row: { ...row, modified_at: new Date().toISOString() }, cols }] }),
    }).catch(() => undefined);
  } catch {
    // The queued push will carry it instead.
  }
}

export async function flush(): Promise<void> {
  if (!navigator.onLine || state.expired) return;
  if (flushing) {
    // An edit made during a push is sent as soon as that push finishes.
    flushAgain = true;
    return;
  }
  flushing = true;
  setState({ busy: true });
  try {
    for (;;) {
      const batch = await db.outbox.orderBy("seq").limit(PUSH_BATCH).toArray();
      if (batch.length === 0) break;
      const response = await api("/api/sync/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ changes: batch.map((entry) => ({ table: entry.table, row: entry.row, cols: entry.cols })) }),
      });
      const { failures, current } = (await response.json()) as { failures: Failure[]; current?: Rows };
      await db.transaction("rw", db.outbox, db.failed, async () => {
        if (failures.length) {
          const at = new Date().toISOString();
          await db.failed.bulkAdd(failures.map((f) => ({ table: f.table, row_id: f.id ?? "", error: f.error, at })));
        }
        await db.outbox.bulkDelete(batch.map((entry) => entry.seq!));
      });
      // Edits the server kept a later version of. Take its version, so this
      // device does not go on showing something the server turned down.
      for (const [table, rows] of Object.entries(current ?? {})) {
        if (SYNCED_TABLES.includes(table as TableName) && rows?.length) await merge(table as TableName, rows);
      }
    }
    setState({ error: null });
    schedulePull(1000);
  } catch (error) {
    reportError(error);
    scheduleFlush(15_000);
  } finally {
    flushing = false;
    setState({ busy: false });
    if (flushAgain) {
      flushAgain = false;
      scheduleFlush(0);
    }
  }
}

// Pulling

let pullTimer: ReturnType<typeof setTimeout> | null = null;
let pulling = false;
let pullAgain = false;

export function schedulePull(delay = 500): void {
  if (pullTimer) clearTimeout(pullTimer);
  pullTimer = setTimeout(() => void pull(), delay);
}

async function merge(table: TableName, rows: Tables[TableName][]): Promise<void> {
  const local = db.table(table);
  await db.transaction("rw", local, db.outbox, async () => {
    const pending = new Set(
      (await db.outbox.where("row.id").anyOf(rows.map((r) => r.id)).toArray()).map((entry) => entry.row.id),
    );
    // A row with an unpushed local edit keeps the local version. Once the edit
    // is pushed, the server decides and the next pull brings the result.
    await local.bulkPut(rows.filter((row) => !pending.has(row.id)));
  });
}

export async function pull(): Promise<void> {
  if (!navigator.onLine || state.expired) return;
  if (pulling) {
    pullAgain = true;
    return;
  }
  pulling = true;
  try {
    let since = (await getMeta<number>("cursor")) ?? 0;
    for (;;) {
      const response = await api(`/api/sync/pull?since=${since}`);
      const result = (await response.json()) as { cursor: number; more: boolean; rows: Rows };
      for (const [table, rows] of Object.entries(result.rows)) {
        // A table added by a newer version is ignored until this one updates.
        if (!SYNCED_TABLES.includes(table as TableName)) continue;
        if (rows?.length) await merge(table as TableName, rows);
      }
      since = result.cursor;
      await setMeta("cursor", since);
      if (!result.more) break;
    }
    setState({ error: null });
  } catch (error) {
    reportError(error);
  } finally {
    pulling = false;
    if (pullAgain) {
      pullAgain = false;
      schedulePull();
    }
  }
}

// Lifecycle

let poll: ReturnType<typeof setInterval> | null = null;

function onOnline() {
  setState({ online: true });
  void flush().then(pull);
}
function onOffline() {
  setState({ online: false });
}
function onVisible() {
  if (document.visibilityState === "visible") {
    schedulePull(0);
    scheduleFlush(0);
  }
}

export function startSync(): void {
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  document.addEventListener("visibilitychange", onVisible);
  poll = setInterval(() => {
    if (document.visibilityState === "visible") {
      void flush();
      void pull();
    }
  }, POLL_MS);
  void flush().then(pull);
}

export function stopSync(): void {
  window.removeEventListener("online", onOnline);
  window.removeEventListener("offline", onOffline);
  document.removeEventListener("visibilitychange", onVisible);
  if (poll) clearInterval(poll);
  poll = null;
}

export async function clearLocalData(): Promise<void> {
  await Promise.all(db.tables.map((table) => table.clear()));
}

// Calls that only make sense online. Failures are ignored.

export async function bumpFile(fileId: string): Promise<void> {
  if (!navigator.onLine) return;
  await api(`/api/files/${encodeURIComponent(fileId)}/bump`, { method: "POST" }).catch(() => undefined);
}

export async function retryFile(fileId: string): Promise<void> {
  if (!navigator.onLine) return;
  await api(`/api/files/${encodeURIComponent(fileId)}/retry`, { method: "POST" }).catch(() => undefined);
  schedulePull(1500);
}
