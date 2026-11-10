// Where Kokoro's model files come from, and why they could not be fetched, in
// words a reader can act on.
//
// transformers.js fetches model files with a plain fetch(url) in a browser
// (@huggingface/transformers 3.8.1 src/utils/hub.js:243). An error status comes
// back as `Could not locate file: "<url>"`; a bare "Failed to fetch", with no
// URL, means fetch() itself rejected and no response arrived: blocked by the
// app's Content-Security-Policy, a network or content filter, an extension or a
// service worker, or no connection at all.
//
// The probe below is a diagnostic only. It is never a gate in front of loading,
// because a probe that fails for its own reasons would stop a model that would
// have loaded. The worker loads first, and probes only after every host has
// failed, so the message can say which hosts could not be reached and why.
//
// Hosts. School and workplace filters often block huggingface.co. The worker
// tries each host in MODEL_HOSTS in turn by rewriting the canonical Hub URLs
// that transformers.js and the voice loader request (mirrorUrl), so the Cache
// Storage keys stay the canonical URLs and a model cached through a mirror is
// found again whichever host is reachable next time.

export const HUB = "https://huggingface.co/";

/** The Hub itself, then a public mirror that serves the same paths. */
export const MODEL_HOSTS = ["https://huggingface.co", "https://hf-mirror.com"];

export type ProbeKind = "csp" | "network" | "not-found" | "forbidden" | "server" | "html";

export interface ProbeResult {
  modelId: string;
  url: string;
  ok: boolean;
  kind?: ProbeKind;
  status?: number;
  detail: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A host as an origin with no trailing slash, so hosts compare and join predictably. */
export function normaliseHost(host: string): string {
  return host.trim().replace(/\/+$/, "");
}

/**
 * The URL to request when `host` stands in for the Hub. Only URLs on the
 * canonical Hub are rewritten, so the ONNX Runtime files from a CDN and the
 * kokoro-js code itself are never sent to a model mirror.
 */
export function mirrorUrl(url: string, host: string): string {
  const canonical = normaliseHost(HUB);
  const target = normaliseHost(host);
  if (target === canonical || !url.startsWith(`${canonical}/`)) return url;
  return `${target}${url.slice(canonical.length)}`;
}

/**
 * Whether a load error means the host could not be reached at all, as opposed
 * to a missing file or a model that would not run. A host that cannot be
 * reached is not tried again with another dtype; the next host is tried instead.
 */
export function isNetworkFailure(message: string): boolean {
  return /Failed to fetch|NetworkError|Load failed|network error|ERR_[A-Z_]+|gave no answer|could not be reached|timed out/i.test(message);
}

/** The config.json URL transformers.js requests first for a model on the Hub. */
export function configUrl(modelId: string, host = HUB): string {
  const root = host.endsWith("/") ? host : `${host}/`;
  return `${root}${modelId}/resolve/main/config.json`;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Fetch a model's config.json and say exactly what went wrong. `violations`
 * returns the CSP violations seen so far, so a blocked request is reported as
 * a CSP block rather than as a generic network failure. The request is a plain
 * GET that follows redirects, exactly as transformers.js makes it, so the probe
 * can never fail where the real download would succeed.
 */
export async function probeModel(modelId: string, fetchFn: FetchLike, violations: () => string[] = () => [], host = HUB): Promise<ProbeResult> {
  const url = configUrl(modelId, host);
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (e) {
    const blocked = violations().find((v) => v.includes(originOf(url)));
    if (blocked) return { modelId, url, ok: false, kind: "csp", detail: blocked };
    return { modelId, url, ok: false, kind: "network", detail: e instanceof Error ? e.message : String(e) };
  }
  if (res.status === 404) return { modelId, url, ok: false, kind: "not-found", status: 404, detail: `${modelId} is not on the model host` };
  if (res.status === 401 || res.status === 403) return { modelId, url, ok: false, kind: "forbidden", status: res.status, detail: `the model host refused ${modelId}` };
  if (!res.ok) return { modelId, url, ok: false, kind: "server", status: res.status, detail: `the model host answered ${res.status}` };
  const body = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/html") || body.trimStart().startsWith("<")) {
    return { modelId, url, ok: false, kind: "html", status: res.status, detail: `${url} returned a web page instead of the model's configuration` };
  }
  return { modelId, url, ok: true, status: res.status, detail: "reachable" };
}

const CAUSES = "no connection, a network or content filter, an extension, or a service worker blocking it";

/** "a", "a or b", "a, b or c", for naming every host that failed the same way. */
function joinOrigins(origins: string[], word: "or" | "and"): string {
  if (origins.length <= 1) return origins[0] ?? "";
  return `${origins.slice(0, -1).join(", ")} ${word} ${origins[origins.length - 1]}`;
}

const ADVICE: Record<ProbeKind, (r: ProbeResult, origins: string[]) => string> = {
  csp: (_r, origins) => `the app's Content-Security-Policy blocked ${joinOrigins(origins, "and")}; allow ${origins.length > 1 ? "them" : "it"} in connect-src`,
  network: (r, origins) =>
    origins.length > 1
      ? `none of ${joinOrigins(origins, "or")} could be reached (${CAUSES})`
      : `${originOf(r.url)} could not be reached (${CAUSES})`,
  "not-found": (r) => `${r.modelId} is not on ${originOf(r.url)}`,
  forbidden: (r) => `${originOf(r.url)} refused access to ${r.modelId}`,
  server: (r) => `${originOf(r.url)} had an error (${r.status ?? "unknown"})`,
  html: (r) => `${originOf(r.url)} returned a web page instead of model files`,
};

/**
 * One sentence naming the most useful failure: a block or an outage before a
 * missing model. When several hosts failed the same way, all of them are
 * named, so a reader knows the mirror was tried as well.
 */
export function explainProbes(results: ProbeResult[]): string {
  const order: ProbeKind[] = ["csp", "network", "html", "forbidden", "server", "not-found"];
  const failed = results.filter((r) => !r.ok && r.kind).sort((a, b) => order.indexOf(a.kind!) - order.indexOf(b.kind!));
  if (failed.length === 0) return "Kokoro could not load, although its model host was reachable.";
  const top = failed[0];
  const origins = [...new Set(failed.filter((r) => r.kind === top.kind).map((r) => originOf(r.url)))];
  return `Kokoro could not load: ${ADVICE[top.kind!](top, origins)}.`;
}
