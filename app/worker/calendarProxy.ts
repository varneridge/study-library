// Fetches a Google Calendar secret iCal feed for the browser, which cannot
// read it directly because Google sends no CORS headers. Only the shape of
// address that Google itself gives out is accepted, redirects are never
// followed, and the body is capped and timed, so the route cannot be turned
// into a way of reaching anything else.

export const MAX_FEED_BYTES = 5 * 1024 * 1024;
export const FEED_TIMEOUT_MS = 15_000;

const HOST = "calendar.google.com";
const PATH_RE = /^\/calendar\/ical\/[^/]+\/(private-[0-9a-f]+|public)\/basic\.ics$/;
const MAX_URL_LENGTH = 2048;

export type IcsUrlCheck = { ok: true; parsed: URL } | { ok: false; error: string };

export function validateIcsUrl(url: string): IcsUrlCheck {
  if (typeof url !== "string" || url.length > MAX_URL_LENGTH) return { ok: false, error: "That is not a web address." };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "That is not a web address." };
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "The address must start with https." };
  if (parsed.username || parsed.password) return { ok: false, error: "The address must not hold a username or password." };
  // The URL parser drops a default port, so only an unusual one reaches this.
  if (parsed.port !== "") return { ok: false, error: "The address must not name a port." };
  if (parsed.hostname !== HOST) return { ok: false, error: `The address must be on ${HOST}.` };
  if (!PATH_RE.test(parsed.pathname)) return { ok: false, error: "That is not the secret address in iCal format of a Google calendar." };
  return { ok: true, parsed };
}

function json(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status });
}

// A fetch or a body read that failed: too slow, or not reachable at all.
function failed(error: unknown): Response {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return json({ error: "timeout" }, 504);
  return json({ error: "upstream", status: 0 }, 502);
}

// Answers with the feed as text/calendar, or with { error } and a status the
// browser reads: bad_url 400, too_large 413, upstream 502 or timeout 504.
export async function proxyIcsFeed(_env: unknown, url: string): Promise<Response> {
  const checked = validateIcsUrl(url);
  if (!checked.ok) return json({ error: "bad_url" }, 400);
  // Anything after the path is dropped, so only the address Google gave is asked for.
  const target = `${checked.parsed.origin}${checked.parsed.pathname}`;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      headers: { accept: "text/calendar, */*;q=0.1" },
    });
  } catch (error) {
    return failed(error);
  }

  // A redirect is an answer in its own right, so it is reported and never followed.
  if (upstream.status !== 200) {
    void upstream.body?.cancel().catch(() => undefined);
    return json({ error: "upstream", status: upstream.status }, 502);
  }
  if (Number(upstream.headers.get("content-length")) > MAX_FEED_BYTES) {
    void upstream.body?.cancel().catch(() => undefined);
    return json({ error: "too_large" }, 413);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = upstream.body?.getReader();
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FEED_BYTES) {
        await reader.cancel().catch(() => undefined);
        return json({ error: "too_large" }, 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    return failed(error);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "x-fetched-at": new Date().toISOString(),
      "cache-control": "no-store",
    },
  });
}
