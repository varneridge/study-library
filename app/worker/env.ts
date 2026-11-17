export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  // Local development and tests only.
  ALLOW_UNAUTHENTICATED?: string;
  DEV_RESET?: string;
  // Shared secret for the processor. Set with `wrangler secret put PROCESSOR_KEY`.
  PROCESSOR_KEY?: string;
  // Service token credentials the background processor sends as its own sign-in.
  PROCESSOR_ACCESS_CLIENT_ID?: string;
  PROCESSOR_ACCESS_CLIENT_SECRET?: string;
  // Email sign-in. AUTH_SECRET keys the HMAC over sign-in codes, so set it with
  // `wrangler secret put AUTH_SECRET` to a long random value.
  AUTH_SECRET?: string;
  // Who may sign in, as addresses separated by commas or spaces.
  AUTH_ALLOWED_EMAILS?: string;
  // The sender of sign-in emails, such as "Study Library <signin@example.com>".
  AUTH_EMAIL_FROM?: string;
  // Sends through Resend when set, and otherwise through the AUTH_EMAIL binding.
  RESEND_API_KEY?: string;
  // Cloudflare's send_email binding, for addresses verified in Email Routing.
  AUTH_EMAIL?: SendEmail;
  // "true" in .dev.vars only. On localhost with no way to send email, the code
  // is logged and returned to the page instead.
  AUTH_DEV_MODE?: string;
}

export const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// Server writes stamp a row just after its stored version, so they win under
// last-write-wins even if a device clock runs ahead of the server.
export const TOUCH =
  "modified_at = max(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), " +
  "strftime('%Y-%m-%dT%H:%M:%fZ', julianday(modified_at) + 2.0 / 86400000.0))";
