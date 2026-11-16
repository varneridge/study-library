// Google Calendar, read through the calendar's secret iCal address. The Worker
// fetches the feed (worker/calendarProxy.ts), the parser turns it into
// occurrences (ical.ts), and they are kept on this device in gcal_events so the
// calendar opens at once and works offline. The cache is replaced whole and in
// one transaction, so a refresh that fails halfway leaves the last good copy.

import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { CALENDAR_SETTINGS_ID, readCalendarSettings } from "./calendar";
import { addDays, todayLocal } from "./civilDate";
import { db, getMeta, setMeta, type GcalEvent } from "./db";
import { parseIcal } from "./ical";

export interface GcalStatus {
  // When the cache was last rebuilt from the feed, or null if it never has been.
  syncedAt: string | null;
  // What went wrong with the last refresh, in words for the page, or null.
  error: string | null;
  refreshing: boolean;
}

export const STALE_AFTER_MS = 30 * 60 * 1000;
// The feed is read from this far behind today to this far ahead.
const DAYS_BEHIND = 90;
const DAYS_AHEAD = 400;

const SYNCED_KEY = "gcal:synced_at";
const HASH_KEY = "gcal:url_hash";
const ERROR_KEY = "gcal:error";
const LOCK_NAME = "gcal-refresh";

// A failure whose message is already fit to show.
class RefreshError extends Error {}

// A fingerprint of the address, so that a changed address is noticed without
// keeping a second copy of the secret. Pages served without a secure context
// have no crypto.subtle, and a plain FNV-1a hash does the same job there.
export async function hashUrl(url: string): Promise<string> {
  const subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(url));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnv-${(h >>> 0).toString(16)}`;
}

let busy = false;
const busyListeners = new Set<(value: boolean) => void>();

function setBusy(value: boolean): void {
  busy = value;
  busyListeners.forEach((listener) => listener(value));
}

async function readStatus(): Promise<GcalStatus> {
  try {
    const [syncedAt, error] = await Promise.all([getMeta<unknown>(SYNCED_KEY), getMeta<unknown>(ERROR_KEY)]);
    return {
      syncedAt: typeof syncedAt === "string" ? syncedAt : null,
      error: typeof error === "string" ? error : null,
      refreshing: busy,
    };
  } catch {
    return { syncedAt: null, error: null, refreshing: busy };
  }
}

async function currentUrl(): Promise<string | null> {
  const row = await db.settings.get(CALENDAR_SETTINGS_ID);
  return readCalendarSettings(row && !row.deleted ? row.value : undefined).icsUrl;
}

// With no address there is nothing to show, so the cache and what describes it go.
async function clearCache(): Promise<void> {
  await db.transaction("rw", db.gcal_events, db.meta, async () => {
    await db.gcal_events.clear();
    await db.meta.bulkDelete([SYNCED_KEY, HASH_KEY]);
    await setMeta(ERROR_KEY, null);
  });
}

// Fresh means built from this address within the last half hour, and not
// followed by a failure, so that a failed refresh is tried again on the next look.
async function isFresh(hash: string): Promise<boolean> {
  const [at, stored, error] = await Promise.all([getMeta<unknown>(SYNCED_KEY), getMeta<unknown>(HASH_KEY), getMeta<unknown>(ERROR_KEY)]);
  if (stored !== hash || typeof at !== "string" || error) return false;
  const age = Date.now() - Date.parse(at);
  return age >= 0 && age < STALE_AFTER_MS;
}

async function messageFor(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown; status?: unknown } | null;
  switch (body?.error) {
    case "bad_url":
      return "That does not look like the secret address in iCal format of a Google calendar. Copy it again from the calendar's settings.";
    case "too_large":
      return "The calendar feed is too large to read.";
    case "timeout":
      return "Google Calendar took too long to reply.";
    case "upstream":
      return body.status === 403 || body.status === 404 || body.status === 410
        ? "Google no longer accepts that address. It may have been reset, so copy the new one from the calendar's settings."
        : "Google Calendar replied with an error.";
  }
  if (response.status === 401 || response.status === 403) return "Your sign in has expired. Reload the page and try again.";
  return "Google Calendar could not be refreshed.";
}

async function download(url: string): Promise<GcalEvent[]> {
  let response: Response;
  try {
    response = await fetch("/api/calendar/ics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
  } catch {
    throw new RefreshError(typeof navigator !== "undefined" && navigator.onLine === false ? "You are offline." : "Google Calendar could not be reached.");
  }
  if (!response.ok) throw new RefreshError(await messageFor(response));
  const text = await response.text();
  // A page that is not a calendar must never replace the cache with nothing.
  if (!text.trimStart().toUpperCase().startsWith("BEGIN:VCALENDAR")) {
    throw new RefreshError("Google sent something other than a calendar. Check the address and try again.");
  }
  const today = todayLocal();
  return parseIcal(text, { from: addDays(today, -DAYS_BEHIND), to: addDays(today, DAYS_AHEAD) }).events;
}

// Replaces the cache in one transaction. The address is read again inside it,
// so a feed fetched for an address that has since been changed is not stored.
async function store(url: string, hash: string, events: GcalEvent[]): Promise<boolean> {
  return db.transaction("rw", [db.gcal_events, db.meta, db.settings], async () => {
    const row = await db.settings.get(CALENDAR_SETTINGS_ID);
    if (readCalendarSettings(row && !row.deleted ? row.value : undefined).icsUrl !== url) return false;
    await db.gcal_events.clear();
    await db.gcal_events.bulkPut(events);
    await setMeta(SYNCED_KEY, new Date().toISOString());
    await setMeta(HASH_KEY, hash);
    await setMeta(ERROR_KEY, null);
    return true;
  });
}

async function recordError(error: unknown): Promise<void> {
  const reason = error instanceof RefreshError ? error.message : "Google Calendar could not be refreshed.";
  const cached = await db.gcal_events.count().catch(() => 0);
  const message = cached > 0 ? `${reason} These events are from your last refresh.` : reason;
  await setMeta(ERROR_KEY, message).catch(() => undefined);
}

// "changed" means the address was replaced while its feed was on the way.
async function fetchIfNeeded(url: string, hash: string, force: boolean): Promise<"done" | "changed"> {
  if (!force && (await isFresh(hash))) return "done";
  setBusy(true);
  try {
    return (await store(url, hash, await download(url))) ? "done" : "changed";
  } catch (error) {
    await recordError(error);
    return "done";
  } finally {
    setBusy(false);
  }
}

async function refreshOnce(force: boolean): Promise<"done" | "changed"> {
  const url = await currentUrl();
  if (!url) {
    await clearCache();
    return "done";
  }
  const hash = await hashUrl(url);
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) return fetchIfNeeded(url, hash, force);
  // Another tab already refreshing will write the cache this one reads, so a
  // tab that cannot take the lock has nothing to do.
  return locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => (lock ? fetchIfNeeded(url, hash, force) : "done"));
}

async function settle(force: boolean): Promise<GcalStatus> {
  try {
    // An address replaced mid-refresh is fetched again straight away, a few times at most.
    for (let attempt = 0; attempt < 3; attempt++) {
      if ((await refreshOnce(force)) === "done") break;
    }
  } catch (error) {
    await recordError(error);
  }
  return readStatus();
}

let inflight: Promise<GcalStatus> | null = null;

// Brings the cache up to date, unless it is fresh and force is not set. It
// never rejects: what went wrong is in the returned status and in gcal:error.
// Calls made while one is running share its result.
export function refreshGoogle(opts: { force?: boolean } = {}): Promise<GcalStatus> {
  if (!inflight) inflight = settle(Boolean(opts.force)).finally(() => { inflight = null; });
  return inflight;
}

// The refresh state for the page: when it last worked, what last went wrong,
// and whether one is running in this tab now.
export function useGcalStatus(): GcalStatus {
  const stored = useLiveQuery(async () => {
    const [syncedAt, error] = await Promise.all([getMeta<unknown>(SYNCED_KEY), getMeta<unknown>(ERROR_KEY)]);
    return {
      syncedAt: typeof syncedAt === "string" ? syncedAt : null,
      error: typeof error === "string" ? error : null,
    };
  }, []);
  const [refreshing, setRefreshing] = useState(busy);
  useEffect(() => {
    busyListeners.add(setRefreshing);
    setRefreshing(busy);
    return () => {
      busyListeners.delete(setRefreshing);
    };
  }, []);
  return { syncedAt: stored?.syncedAt ?? null, error: stored?.error ?? null, refreshing };
}
