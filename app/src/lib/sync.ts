// The sync engine.
//
// Every edit is written to IndexedDB and added to an outbox in one
// transaction. The outbox is pushed to the Worker, which keeps the newest
// version of each row. Pulling asks for every row written since a cursor.

import { liveQuery } from "dexie";
import { db, getMeta, setMeta } from "./db";
import { SYNCED_TABLES, type TableName, type Tables } from "./types";

const PUSH_BATCH = 200;
const POLL_MS = 30_000;

let lastStamp = 0;

// RFC 9562 time-ordered UUID v7, using the browser's CSPRNG.
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const now = BigInt(Date.now());
  bytes[0] = Number((now >> 40n) & 0xffn);
  bytes[1] = Number((now >> 32n) & 0xffn);
  bytes[2] = Number((now >> 24n) & 0xffn);
  bytes[3] = Number((now >> 16n) & 0xffn);
  bytes[4] = Number((now >> 8n) & 0xffn);
  bytes[5] = Number(now & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Timestamps never repeat on one device, so two quick edits keep their order.
function stamp(): string {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return new Date(lastStamp).toISOString();
}

// Requests

export class SessionExpired extends Error {}

// The Worker answers a missing or ended session with 401, which shows the
// sign-in screen. A redirect is treated the same way, since that is how
// Cloudflare Access answers if it is still in front of the site. A 503 is an
// outage rather than a signed-out device, so it is reported as an error and
// everything stays as it is.
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, { ...init, redirect: "manual", credentials: "same-origin" });
  if (response.type === "opaqueredirect" || response.status === 401) {
    setState({ expired: true });
    throw new SessionExpired("Signed out");
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${text.slice(0, 300)}`);
  }
  return response;
}

// Writing

export type Fresh<T extends TableName> = Omit<Tables[T], "modified_at" | "deleted" | "seq"> & { deleted?: boolean };

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
//
// busy means a push is under way and pulling means a pull is, while pending
// counts the edits and uploads on this device that have not reached the
// server yet. syncStatus in ./syncStatus turns these into the one symbol shown.

export type SyncState = {
  online: boolean;
  busy: boolean;
  pulling: boolean;
  paused: boolean;
  pending: number;
  error: string | null;
  expired: boolean;
};
let state: SyncState = {
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  busy: false,
  pulling: false,
  paused: false,
  pending: 0,
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

// The state as it stands now, so a component can draw the right symbol on its
// first render rather than waiting for its subscription.
export function currentSyncState(): SyncState {
  return state;
}

export function isSyncExpired(): boolean {
  return state.expired;
}

function reportError(error: unknown) {
  if (error instanceof SessionExpired) return;
  setState({ error: error instanceof Error ? error.message : String(error) });
}

// Pushing

let paused = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let flushAgain = false;

export function isSyncPaused(): boolean {
  return paused;
}

export function scheduleFlush(delay = 300): void {
  if (paused) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flush(), delay);
}

interface Failure {
  table: string;
  id: string | null;
  error: string;
}

export function describeFailedChange(table: string): string {
  const map: Record<string, string> = {
    modules: "a module",
    weeks: "a week",
    sessions: "a session",
    files: "a file",
    items: "a reading",
    questions: "a question",
    highlights: "a highlight",
    notes: "a note",
    note_blocks: "part of a note",
    recordings: "a recording",
    applications: "an application",
    application_events: "a job application event",
    week_items: "a reading in a week",
    settings: "a setting",
  };
  const noun = map[table];
  return noun ? `A change to ${noun} could not be saved.` : "A change could not be saved.";
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
  if (paused || !navigator.onLine || state.expired) return;
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
    if (flushAgain && !paused) {
      flushAgain = false;
      scheduleFlush(0);
    }
  }
}

// Pulling

let pullTimer: ReturnType<typeof setTimeout> | null = null;
let pulling = false;
let pullAgain = false;
let currentPull: Promise<boolean> | null = null;

export function schedulePull(delay = 500): void {
  if (paused) return;
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

export async function pull(options: { join?: boolean } = {}): Promise<boolean> {
  if (paused || !navigator.onLine || state.expired) return false;
  if (currentPull) {
    if (!options.join) pullAgain = true;
    return currentPull;
  }
  pulling = true;
  setState({ pulling: true });
  currentPull = (async () => {
    let ok = false;
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
      ok = true;
    } catch (error) {
      reportError(error);
    } finally {
      pulling = false;
      currentPull = null;
      setState({ pulling: false });
      if (pullAgain && !paused) {
        pullAgain = false;
        schedulePull();
      }
    }
    return ok;
  })();
  return currentPull;
}

// Lifecycle

let poll: ReturnType<typeof setInterval> | null = null;
let pendingWatch: { unsubscribe(): void } | null = null;

function onOnline() {
  setState({ online: true });
  void flush().then(() => pull());
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

// Counts what is still waiting to reach the server. Uploads are queued by
// ./uploads rather than here, so the count follows both tables directly.
function watchPending() {
  pendingWatch?.unsubscribe();
  pendingWatch = liveQuery(async () => (await db.outbox.count()) + (await db.uploads.count())).subscribe({
    next: (pending) => setState({ pending }),
    error: () => undefined,
  });
}

export function startSync(): void {
  if (paused) return;
  stopSync();
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    poll = setInterval(() => {
      if (document.visibilityState === "visible") {
        void flush();
        void pull();
      }
    }, POLL_MS);
    watchPending();
  }
  // Once the first pull is in, older data is tidied a single time: slides
  // are named, and weeks are cleared of the empty sessions made for them.
  void flush()
    .then(() => pull())
    .then(() => import("./names"))
    .then((names) => names.nameSlidesOnce())
    .then(() => import("./edits"))
    .then((edits) => edits.resetSessionsOnce())
    .catch(() => undefined);
}

export function stopSync(): void {
  if (typeof window !== "undefined") {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    document.removeEventListener("visibilitychange", onVisible);
  }
  if (poll) clearInterval(poll);
  poll = null;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (pullTimer) clearTimeout(pullTimer);
  pullTimer = null;
  pendingWatch?.unsubscribe();
  pendingWatch = null;
  flushAgain = false;
  pullAgain = false;
}

export async function pauseSync(): Promise<void> {
  paused = true;
  setState({ paused: true });
  stopSync();
  const start = Date.now();
  try {
    while (flushing || pulling) {
      if (Date.now() - start > 15_000) {
        throw new Error("Sync is still busy. Wait a moment and try again.");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } catch (error) {
    paused = false;
    setState({ paused: false });
    startSync();
    throw error;
  }
}

export function resumeSync(): void {
  paused = false;
  setState({ paused: false });
  startSync();
}

// Signing in
//
// A code is emailed and typed in, and the Worker answers with an HttpOnly
// session cookie this code never sees. Signing out ends only the session:
// everything saved on the device, unsent edits included, stays, and is sent
// once someone signs in again.

const AUTH_ERRORS: Record<string, string> = {
  bad_email: "That does not look like an email address, so check it and try again.",
  invalid_code: "That code is not right. Check the newest email, as only its code works.",
  code_expired: "That code has expired or been replaced, so ask for a new one.",
  too_many_attempts: "That code has been tried too many times, so ask for a new one.",
  auth_not_configured: "Email sign-in is not set up on the server yet, so no code can be sent.",
  auth_unavailable: "The server could not check sign-ins just now, so try again in a moment.",
};

async function authRequest(path: string, body?: unknown): Promise<Response> {
  if (!navigator.onLine) throw new Error("You are offline, so connect to the internet to sign in or out.");
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("The server could not be reached, so check you are online and try again.");
  }
  if (response.ok) return response;
  const { error } = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(AUTH_ERRORS[error ?? ""] ?? `The server answered ${response.status}, so try again in a moment.`);
}

// The address last used to sign in on this device, to fill the form next time.
export async function lastSignInEmail(): Promise<string> {
  return (await getMeta<string>("auth-email")) ?? "";
}

// Always answered the same way whether or not the address may sign in, so the
// caller learns nothing about the allowlist. devCode comes only from a local
// Worker in dev mode that has no way to send email.
export async function requestSignInCode(email: string): Promise<{ devCode: string | null }> {
  const response = await authRequest("/api/auth/request", { email });
  const { dev_code } = (await response.json().catch(() => ({}))) as { dev_code?: string };
  return { devCode: dev_code ?? null };
}

export async function verifySignInCode(email: string, code: string): Promise<void> {
  const response = await authRequest("/api/auth/verify", { email, code });
  const { email: signedIn } = (await response.json()) as { email: string };
  await setMeta("auth-email", signedIn);
  setState({ expired: false, error: null });
  // Whatever waited while signed out goes now.
  scheduleFlush(0);
  schedulePull(0);
}

export async function signOut(): Promise<void> {
  await authRequest("/api/auth/logout");
  setState({ expired: true });
}

// Ends every session for this address but this one. The processor signs in
// with its own token, so it carries on.
export async function signOutOtherDevices(): Promise<number> {
  const response = await authRequest("/api/auth/logout-others");
  const { removed } = (await response.json()) as { removed: number };
  return removed;
}

// The address signed in on this device, or null for the processor's token or local tests.
export async function fetchAccount(): Promise<string | null> {
  const response = await api("/api/auth/session");
  const { email } = (await response.json()) as { email: string | null };
  return email;
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
