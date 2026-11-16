// Tests for the Google Calendar feed proxy. Runs on its own with
// `npx tsx tests/calendarProxy.ts` from app/, and replaces fetch so that
// nothing leaves the machine.

import assert from "node:assert/strict";
import { FEED_TIMEOUT_MS, MAX_FEED_BYTES, proxyIcsFeed, validateIcsUrl } from "../worker/calendarProxy";

const env = {};
const GOOD = "https://calendar.google.com/calendar/ical/student%40example.com/private-0a1b2c3d4e5f/basic.ics";
const FEED = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

const realFetch = globalThis.fetch;
const realTimeout = AbortSignal.timeout;
let calls: { url: string; init: RequestInit }[] = [];

function serve(handler: (url: string, init: RequestInit) => Promise<Response> | Response): void {
  calls = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof fetch;
}

// Tests are queued and run one after another, so the file needs no top level
// await and runs the same whether the package is a module or not.
const queue: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  queue.push({ name, fn });
}

async function bodyOf(response: Response): Promise<unknown> {
  return response.json();
}

// A body that hands out `chunks` pieces of `size` bytes, counting how many were pulled.
function endless(chunks: number, size: number, pulled: { n: number; cancelled: boolean }): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled.n >= chunks) return controller.close();
      pulled.n++;
      controller.enqueue(new Uint8Array(size));
    },
    cancel() {
      pulled.cancelled = true;
    },
  });
}

test("accepts a private address and a public one", () => {
  assert.equal(validateIcsUrl(GOOD).ok, true);
  assert.equal(validateIcsUrl("https://calendar.google.com/calendar/ical/en.uk%23holiday%40group.v.calendar.google.com/public/basic.ics").ok, true);
  assert.equal(validateIcsUrl("https://CALENDAR.GOOGLE.COM/calendar/ical/a/private-ab12/basic.ics").ok, true);
});

test("rejects anything that is not Google's own address shape", () => {
  const bad = [
    "", "not a url", `${GOOD}${"a".repeat(3000)}`,
    GOOD.replace("https:", "http:"),
    GOOD.replace("calendar.google.com", "evil.com"),
    GOOD.replace("calendar.google.com", "calendar.google.com.evil.com"),
    GOOD.replace("calendar.google.com", "calendar.google.com."),
    GOOD.replace("https://", "https://calendar.google.com@evil.com/"),
    GOOD.replace("https://", "https://user:pass@"),
    GOOD.replace("calendar.google.com", "calendar.google.com:8443"),
    "https://evil.com/calendar.google.com/calendar/ical/a/public/basic.ics",
    "https://calendar.google.com\\@evil.com/calendar/ical/a/public/basic.ics",
    "https://calendar.google.com/calendar/ical/../../etc/public/basic.ics",
    "https://calendar.google.com/calendar/ical/a/%2e%2e/basic.ics",
    "https://calendar.google.com/calendar/ical/a/private-ZZ/basic.ics",
    "https://calendar.google.com/calendar/ical/a/private-/basic.ics",
    "https://calendar.google.com/calendar/ical/a/b/private-ab12/basic.ics",
    "https://calendar.google.com/calendar/ical//private-ab12/basic.ics",
    "https://calendar.google.com/calendar/ical/a/private-ab12/basic.ics/",
    "https://calendar.google.com/calendar/ical/a/private-ab12/basic.ics.evil",
    "https://calendar.google.com/calendar/u/0/r",
    "javascript:alert(1)", "file:///etc/passwd",
  ];
  for (const url of bad) {
    const result = validateIcsUrl(url);
    assert.equal(result.ok, false, `should reject ${url.slice(0, 80)}`);
    if (!result.ok) assert.ok(result.error.length > 0);
  }
});

test("a bad address is a 400 and nothing is fetched", async () => {
  serve(() => new Response(FEED));
  const response = await proxyIcsFeed(env, "https://evil.com/calendar/ical/a/public/basic.ics");
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), { error: "bad_url" });
  assert.equal(calls.length, 0);
});

test("a feed comes back as text/calendar with the time it was fetched", async () => {
  serve(() => new Response(FEED, { status: 200, headers: { "content-type": "text/plain" } }));
  const before = Date.now();
  const response = await proxyIcsFeed(env, `${GOOD}?x=1#frag`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/calendar/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const fetchedAt = Date.parse(response.headers.get("x-fetched-at") ?? "");
  assert.ok(fetchedAt >= before - 1000 && fetchedAt <= Date.now() + 1000);
  assert.equal(await response.text(), FEED);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GOOD, "the query and fragment are dropped");
  assert.equal(calls[0].init.redirect, "manual");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("the timeout is fifteen seconds", async () => {
  let asked = 0;
  AbortSignal.timeout = ((ms: number) => {
    asked = ms;
    return realTimeout(ms);
  }) as typeof AbortSignal.timeout;
  serve(() => new Response(FEED));
  await proxyIcsFeed(env, GOOD);
  assert.equal(asked, 15_000);
  assert.equal(FEED_TIMEOUT_MS, 15_000);
});

test("a redirect is reported and never followed", async () => {
  serve(() => new Response(null, { status: 302, headers: { location: "https://evil.com/" } }));
  const response = await proxyIcsFeed(env, GOOD);
  assert.equal(response.status, 502);
  assert.deepEqual(await bodyOf(response), { error: "upstream", status: 302 });
  assert.equal(calls.length, 1);
});

test("an error from Google is passed on as upstream", async () => {
  for (const status of [301, 403, 404, 500, 204]) {
    serve(() => new Response(status === 204 ? null : "x", { status }));
    const response = await proxyIcsFeed(env, GOOD);
    assert.equal(response.status, 502);
    assert.deepEqual(await bodyOf(response), { error: "upstream", status });
  }
});

test("an unreachable Google is upstream with status 0", async () => {
  serve(() => Promise.reject(new TypeError("fetch failed")));
  const response = await proxyIcsFeed(env, GOOD);
  assert.equal(response.status, 502);
  assert.deepEqual(await bodyOf(response), { error: "upstream", status: 0 });
});

test("a feed of exactly 5 MB is allowed and one byte more is not", async () => {
  assert.equal(MAX_FEED_BYTES, 5 * 1024 * 1024);
  serve(() => new Response(new Uint8Array(MAX_FEED_BYTES)));
  const ok = await proxyIcsFeed(env, GOOD);
  assert.equal(ok.status, 200);
  assert.equal((await ok.arrayBuffer()).byteLength, MAX_FEED_BYTES);
  serve(() => new Response(new Uint8Array(MAX_FEED_BYTES + 1)));
  const big = await proxyIcsFeed(env, GOOD);
  assert.equal(big.status, 413);
  assert.deepEqual(await bodyOf(big), { error: "too_large" });
});

test("a long body is cut off while it streams, and the rest is never read", async () => {
  const pulled = { n: 0, cancelled: false };
  serve(() => new Response(endless(1000, 1024 * 1024, pulled)));
  const response = await proxyIcsFeed(env, GOOD);
  assert.equal(response.status, 413);
  assert.equal(pulled.cancelled, true);
  assert.ok(pulled.n <= 8, `read ${pulled.n} MB before stopping`);
});

test("a declared length over the cap is refused without reading", async () => {
  const pulled = { n: 0, cancelled: false };
  serve(() => new Response(endless(1, 10, pulled), { headers: { "content-length": String(MAX_FEED_BYTES + 1) } }));
  const response = await proxyIcsFeed(env, GOOD);
  assert.equal(response.status, 413);
  await new Promise((resolve) => setTimeout(resolve, 10));
  // A stream fills its first slot by itself, so what matters is that it was cancelled.
  assert.equal(pulled.cancelled, true);
  assert.ok(pulled.n <= 1);
});

test("a request that runs out of time is a 504", async () => {
  AbortSignal.timeout = (() => realTimeout(20)) as typeof AbortSignal.timeout;
  serve((_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  }));
  const response = await proxyIcsFeed(env, GOOD);
  assert.equal(response.status, 504);
  assert.deepEqual(await bodyOf(response), { error: "timeout" });
});

test("a body that stalls part way is also a 504", async () => {
  AbortSignal.timeout = (() => realTimeout(20)) as typeof AbortSignal.timeout;
  serve((_url, init) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("BEGIN:VCALENDAR"));
        init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
      },
    });
    return new Response(stream);
  });
  const response = await proxyIcsFeed(env, GOOD);
  assert.equal(response.status, 504);
});

async function run(): Promise<void> {
  let passed = 0;
  // Node does not let AbortSignal.timeout keep the process alive, so without
  // this the run would end silently while a timeout test was still waiting.
  const keepAlive = setInterval(() => undefined, 1000);
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed++;
    } catch (error) {
      console.error(`FAILED: ${name}`);
      throw error;
    } finally {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    }
  }
  clearInterval(keepAlive);
  console.log(`calendarProxy: ${passed} tests passed`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
