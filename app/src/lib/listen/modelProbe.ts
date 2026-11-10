// Why Kokoro's model could not be fetched, in words a reader can act on.
//
// transformers.js fetches model files with a plain fetch(url) in a browser
// (@huggingface/transformers 3.8.1 src/utils/hub.js:248). An error status comes
// back as `Could not locate file: "<url>"` (hub.js:257-282); a bare "Failed to
// fetch", with no URL, means fetch() itself rejected and no response arrived:
// blocked by the app's Content-Security-Policy, a network or content filter, an
// extension or a service worker, or no connection at all. Probing the model's
// small config.json first tells these apart in milliseconds, before any large
// download, and names the host that failed.

export const HUB = "https://huggingface.co/";

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
 * a CSP block rather than as a generic network failure.
 */
export async function probeModel(modelId: string, fetchFn: FetchLike, violations: () => string[] = () => [], host = HUB): Promise<ProbeResult> {
  const url = configUrl(modelId, host);
  let res: Response;
  try {
    res = await fetchFn(url, { cache: "no-store" });
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

const ADVICE: Record<ProbeKind, (r: ProbeResult) => string> = {
  csp: (r) => `the app's Content-Security-Policy blocked ${originOf(r.url)}; allow it in connect-src`,
  network: (r) => `${originOf(r.url)} could not be reached (no connection, a network or content filter, an extension, or a service worker blocking it)`,
  "not-found": (r) => `${r.modelId} is not on ${originOf(r.url)}`,
  forbidden: (r) => `${originOf(r.url)} refused access to ${r.modelId}`,
  server: (r) => `${originOf(r.url)} had an error (${r.status ?? "unknown"})`,
  html: (r) => `${originOf(r.url)} returned a web page instead of model files`,
};

/** One sentence naming the most useful failure: a block or an outage before a missing model. */
export function explainProbes(results: ProbeResult[]): string {
  const order: ProbeKind[] = ["csp", "network", "html", "forbidden", "server", "not-found"];
  const failed = results.filter((r) => !r.ok && r.kind).sort((a, b) => order.indexOf(a.kind!) - order.indexOf(b.kind!));
  if (failed.length === 0) return "Kokoro could not load, although its model host was reachable.";
  return `Kokoro could not load: ${ADVICE[failed[0].kind!](failed[0])}.`;
}
