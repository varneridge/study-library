// Tests for the Google Calendar cache and its refresh. Runs on its own with
// `npx tsx tests/gcal.ts` from app/. It needs one development dependency,
// fake-indexeddb, to give Dexie a database in Node, and it replaces fetch and
// navigator so that nothing leaves the machine.

import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CALENDAR_SETTINGS_ID } from "../src/lib/calendar";
import { addDays, todayLocal } from "../src/lib/civilDate";
import { db, getMeta, setMeta } from "../src/lib/db";
import { STALE_AFTER_MS, hashUrl, refreshGoogle, useGcalStatus } from "../src/lib/gcal";

const URL_A = "https://calendar.google.com/calendar/ical/a%40example.com/private-aaaa1111/basic.ics";
const URL_B = "https://calendar.google.com/calendar/ical/b%40example.com/private-bbbb2222/basic.ics";

const realFetch = globalThis.fetch;
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
let calls: string[] = [];

function feed(...titles: string[]): string {
  const day = addDays(todayLocal(), 3).replaceAll("-", "");
  const events = titles.map((t) => `BEGIN:VEVENT\r\nUID:${t.replaceAll(" ", "-")}\r\nDTSTART;VALUE=DATE:${day}\r\nSUMMARY:${t}\r\nEND:VEVENT`);
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join("\r\n")}\r\nEND:VCALENDAR\r\n`;
}

function serve(handler: (url: string) => Promise<Response> | Response): void {
  calls = [];
  globalThis.fetch = (async (_input: unknown, init: RequestInit = {}) => {
    const { url } = JSON.parse(String(init.body)) as { url: string };
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
}

const calendar = (text: string) => new Response(text, { status: 200, headers: { "content-type": "text/calendar" } });
const failure = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
}

async function setUrl(url: string | null, deleted = false): Promise<void> {
  await db.settings.put({ id: CALENDAR_SETTINGS_ID, modified_at: "2026-11-16T00:00:00Z", deleted, value: { icsUrl: url, hidden: [] } });
}

async function titles(): Promise<string[]> {
  return (await db.gcal_events.toArray()).map((e) => e.title).sort();
}

const queue: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  queue.push({ name, fn });
}

test("with no address the cache and its notes are cleared", async () => {
  await db.gcal_events.put({ key: "k", title: "Old", start_date: "2026-11-16", end_date: "2026-11-16", start_time: null, end_time: null, all_day: true, location: null, notes: null });
  await setMeta("gcal:synced_at", "2026-11-16T09:00:00.000Z");
  await setMeta("gcal:url_hash", "x");
  await setMeta("gcal:error", "Something");
  serve(() => calendar(feed("Never")));
  const status = await refreshGoogle({ force: true });
  assert.deepEqual(status, { syncedAt: null, error: null, refreshing: false });
  assert.equal(await db.gcal_events.count(), 0);
  assert.equal(await getMeta("gcal:url_hash"), undefined);
  assert.equal(calls.length, 0);
});

test("a deleted settings row counts as no address", async () => {
  await setUrl(URL_A, true);
  serve(() => calendar(feed("Never")));
  await refreshGoogle({ force: true });
  assert.equal(calls.length, 0);
});

test("a refresh posts the address, stores the occurrences and records when and for which address", async () => {
  await setUrl(URL_A);
  serve(() => calendar(feed("Seminar", "Tutorial")));
  const before = Date.now();
  const status = await refreshGoogle();
  assert.deepEqual(calls, [URL_A]);
  assert.deepEqual(await titles(), ["Seminar", "Tutorial"]);
  assert.equal(status.error, null);
  assert.equal(status.refreshing, false);
  assert.ok(Date.parse(status.syncedAt ?? "") >= before - 1000);
  assert.equal(await getMeta("gcal:url_hash"), await hashUrl(URL_A));
  assert.equal(await getMeta("gcal:error"), null);
});

test("only the window from 90 days back to 400 ahead is kept", async () => {
  await setUrl(URL_A);
  const at = (days: number) => addDays(todayLocal(), days).replaceAll("-", "");
  const one = (uid: string, day: string) => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;VALUE=DATE:${day}\r\nSUMMARY:${uid}\r\nEND:VEVENT`;
  const text = `BEGIN:VCALENDAR\r\n${[one("old", at(-91)), one("edge-back", at(-90)), one("edge-ahead", at(400)), one("far", at(401))].join("\r\n")}\r\nEND:VCALENDAR\r\n`;
  serve(() => calendar(text));
  await refreshGoogle();
  assert.deepEqual(await titles(), ["edge-ahead", "edge-back"]);
});

test("a fresh cache is left alone, force and a changed address and a stale one are not", async () => {
  await setUrl(URL_A);
  serve(() => calendar(feed("One")));
  await refreshGoogle();
  await refreshGoogle();
  assert.equal(calls.length, 1, "fresh");
  await refreshGoogle({ force: true });
  assert.equal(calls.length, 2, "forced");
  await setUrl(URL_B);
  serve(() => calendar(feed("Two")));
  await refreshGoogle();
  assert.deepEqual(calls, [URL_B], "changed address");
  assert.deepEqual(await titles(), ["Two"]);
  await setMeta("gcal:synced_at", new Date(Date.now() - STALE_AFTER_MS - 1000).toISOString());
  await refreshGoogle();
  assert.equal(calls.length, 2, "stale");
  await setMeta("gcal:synced_at", new Date(Date.now() + 3600_000).toISOString());
  await refreshGoogle();
  assert.equal(calls.length, 3, "a clock that ran ahead");
});

test("a failure keeps the cache, says so, and is tried again on the next look", async () => {
  await setUrl(URL_A);
  serve(() => calendar(feed("Kept")));
  await refreshGoogle();
  const syncedAt = await getMeta("gcal:synced_at");
  serve(() => Promise.reject(new TypeError("fetch failed")));
  const failed = await refreshGoogle({ force: true });
  assert.equal(failed.error, "Google Calendar could not be reached. These events are from your last refresh.");
  assert.equal(failed.syncedAt, syncedAt);
  assert.deepEqual(await titles(), ["Kept"]);
  serve(() => calendar(feed("Back")));
  const recovered = await refreshGoogle();
  assert.equal(calls.length, 1, "the failure made the cache count as stale");
  assert.equal(recovered.error, null);
  assert.deepEqual(await titles(), ["Back"]);
});

test("with nothing cached a failure does not claim a last refresh", async () => {
  await setUrl(URL_A);
  serve(() => failure(504, { error: "timeout" }));
  const status = await refreshGoogle();
  assert.equal(status.error, "Google Calendar took too long to reply.");
});

test("each way the proxy can fail is put into words", async () => {
  await setUrl(URL_A);
  const cases: [() => Response, RegExp][] = [
    [() => failure(400, { error: "bad_url" }), /secret address in iCal format/],
    [() => failure(413, { error: "too_large" }), /too large/],
    [() => failure(504, { error: "timeout" }), /too long/],
    [() => failure(502, { error: "upstream", status: 404 }), /no longer accepts that address/],
    [() => failure(502, { error: "upstream", status: 403 }), /no longer accepts that address/],
    [() => failure(502, { error: "upstream", status: 500 }), /replied with an error/],
    [() => failure(502, { error: "upstream", status: 302 }), /replied with an error/],
    [() => failure(401), /sign in has expired/],
    [() => failure(500, { error: "boom" }), /could not be refreshed/],
    [() => calendar("<html><body>Sign in</body></html>"), /something other than a calendar/],
    [() => calendar(""), /something other than a calendar/],
  ];
  for (const [reply, expected] of cases) {
    serve(reply);
    const status = await refreshGoogle({ force: true });
    assert.match(status.error ?? "", expected);
  }
});

test("a page that is not a calendar never empties the cache", async () => {
  await setUrl(URL_A);
  serve(() => calendar(feed("Safe")));
  await refreshGoogle();
  serve(() => calendar("<html></html>"));
  await refreshGoogle({ force: true });
  assert.deepEqual(await titles(), ["Safe"]);
});

test("a calendar that really is empty does empty the cache", async () => {
  await setUrl(URL_A);
  serve(() => calendar(feed("Was here")));
  await refreshGoogle();
  serve(() => calendar("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n"));
  const status = await refreshGoogle({ force: true });
  assert.equal(status.error, null);
  assert.equal(await db.gcal_events.count(), 0);
});

test("offline is said plainly", async () => {
  await setUrl(URL_A);
  setNavigator({ onLine: false });
  serve(() => Promise.reject(new TypeError("fetch failed")));
  const status = await refreshGoogle();
  assert.equal(status.error, "You are offline.");
});

test("calls made together share one request", async () => {
  await setUrl(URL_A);
  serve(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return calendar(feed("Once"));
  });
  const pending = [refreshGoogle(), refreshGoogle({ force: true }), refreshGoogle()];
  const statuses = await Promise.all(pending);
  assert.equal(calls.length, 1);
  assert.equal(statuses[0].syncedAt, statuses[2].syncedAt);
  assert.equal(statuses[0].refreshing, false);
  await refreshGoogle({ force: true });
  assert.equal(calls.length, 2, "a later call starts a new request");
});

test("the refreshing flag is up while a request is out and down after", async () => {
  await setUrl(URL_A);
  const shown = () => renderToString(createElement(() => JSON.stringify(useGcalStatus())));
  let during = "";
  serve(async () => {
    during = shown();
    return calendar(feed("Slow"));
  });
  await refreshGoogle();
  assert.match(during, /&quot;refreshing&quot;:true/);
  assert.match(shown(), /&quot;refreshing&quot;:false/);
});

test("an address changed while its feed is on the way is never stored, and the new one is fetched", async () => {
  await setUrl(URL_A);
  serve(async (url) => {
    if (url === URL_A) {
      await setUrl(URL_B);
      return calendar(feed("From A"));
    }
    return calendar(feed("From B"));
  });
  const status = await refreshGoogle({ force: true });
  assert.deepEqual(calls, [URL_A, URL_B]);
  assert.deepEqual(await titles(), ["From B"]);
  assert.equal(status.error, null);
  assert.equal(await getMeta("gcal:url_hash"), await hashUrl(URL_B));
});

test("an address cleared while its feed is on the way leaves an empty cache", async () => {
  await setUrl(URL_A);
  serve(async () => {
    await setUrl(null);
    return calendar(feed("Orphan"));
  });
  await refreshGoogle({ force: true });
  assert.equal(await db.gcal_events.count(), 0);
  assert.equal(await getMeta("gcal:url_hash"), undefined);
});

test("a write that fails part way is rolled back whole", async () => {
  await setUrl(URL_A);
  serve(() => calendar(feed("Before")));
  await refreshGoogle();
  const table = db.gcal_events as unknown as { bulkPut: unknown };
  table.bulkPut = async () => {
    throw new Error("quota exceeded");
  };
  try {
    serve(() => calendar(feed("After")));
    const status = await refreshGoogle({ force: true });
    assert.deepEqual(await titles(), ["Before"]);
    assert.match(status.error ?? "", /could not be refreshed/);
    assert.match(status.error ?? "", /last refresh/);
  } finally {
    delete (table as { bulkPut?: unknown }).bulkPut;
  }
});

test("the tab lock is taken only if free, and a tab without it does nothing", async () => {
  await setUrl(URL_A);
  const asked: { name: string; options: unknown }[] = [];
  const locks = (free: boolean) => ({
    request: async (name: string, options: unknown, callback: (lock: unknown) => Promise<unknown>) => {
      asked.push({ name, options });
      return callback(free ? { name } : null);
    },
  });
  setNavigator({ onLine: true, locks: locks(false) });
  serve(() => calendar(feed("Locked out")));
  await refreshGoogle({ force: true });
  assert.equal(calls.length, 0);
  assert.equal(await db.gcal_events.count(), 0);
  setNavigator({ onLine: true, locks: locks(true) });
  await refreshGoogle({ force: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(await titles(), ["Locked out"]);
  assert.deepEqual(asked.map((a) => a.name), ["gcal-refresh", "gcal-refresh"]);
  assert.deepEqual(asked[0].options, { ifAvailable: true });
});

test("freshness is checked inside the lock, so a tab that waited does not fetch again", async () => {
  await setUrl(URL_A);
  serve(() => calendar(feed("First")));
  setNavigator({
    onLine: true,
    locks: {
      request: async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => {
        // Another tab finishes a refresh between this tab's look and its lock.
        await db.gcal_events.put({ key: "other", title: "Other tab", start_date: "2026-11-16", end_date: "2026-11-16", start_time: null, end_time: null, all_day: true, location: null, notes: null });
        await setMeta("gcal:synced_at", new Date().toISOString());
        await setMeta("gcal:url_hash", await hashUrl(URL_A));
        await setMeta("gcal:error", null);
        return callback({ name: "gcal-refresh" });
      },
    },
  });
  await refreshGoogle();
  assert.equal(calls.length, 0);
  assert.deepEqual(await titles(), ["Other tab"]);
});

test("the address is fingerprinted, not kept", async () => {
  const hash = await hashUrl(URL_A);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, await hashUrl(URL_A));
  assert.notEqual(hash, await hashUrl(URL_B));
  assert.equal(hash.includes("private"), false);
});

async function run(): Promise<void> {
  let passed = 0;
  for (const { name, fn } of queue) {
    await db.transaction("rw", [db.gcal_events, db.meta, db.settings], async () => {
      await db.gcal_events.clear();
      await db.meta.clear();
      await db.settings.clear();
    });
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    try {
      await fn();
      passed++;
    } catch (error) {
      console.error(`FAILED: ${name}`);
      throw error;
    } finally {
      globalThis.fetch = realFetch;
    }
  }
  console.log(`gcal: ${passed} tests passed`);
  db.close();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
