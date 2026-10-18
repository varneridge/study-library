export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  // Local development and tests only.
  ALLOW_UNAUTHENTICATED?: string;
  DEV_RESET?: string;
  // Shared secret for the processor. Set with `wrangler secret put PROCESSOR_KEY`.
  PROCESSOR_KEY?: string;
}

export const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// Server writes stamp a row just after its stored version, so they win under
// last-write-wins even if a device clock runs ahead of the server.
export const TOUCH =
  "modified_at = max(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), " +
  "strftime('%Y-%m-%dT%H:%M:%fZ', julianday(modified_at) + 2.0 / 86400000.0))";
