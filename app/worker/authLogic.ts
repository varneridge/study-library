// Sign-in by emailed code: the parts that need no database, kept apart so the
// web tests can check them. Everything here uses Web Crypto, which the Worker,
// the browser and Node all provide, so the file needs no Worker types.

// A code lasts ten minutes, which is long enough to find the email but short
// enough that an old code left in an inbox is of no use to anyone.
export const CODE_TTL_MS = 10 * 60_000;
export const RESEND_COOLDOWN_MS = 60_000;
export const HOURLY_LIMIT = 5;
export const MAX_ATTEMPTS = 5;
// A session lasts sixty days from its last use, so a device in regular use stays signed in.
export const SESSION_IDLE_MS = 60 * 86_400_000;
// Last use is written at most hourly, so ordinary requests do not each cost a write.
export const SESSION_TOUCH_MS = 3_600_000;
export const SESSION_COOKIE = "sl_session";
// Browsers keep a cookie for 400 days at most, and the server's own expiry
// ends an idle session long before that, so the cookie never needs renewing.
export const COOKIE_MAX_AGE_S = 400 * 86_400;

const HOUR_MS = 3_600_000;
// 4294 times a million, the last whole million below 2^32, so every code is equally likely.
const CODE_LIMIT = 4_294_000_000;
const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

// AUTH_ALLOWED_EMAILS may separate addresses with commas, semicolons or spaces.
export function allowedEmails(list: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (list ?? "").split(/[\s,;]+/)) {
    const email = normaliseEmail(part);
    if (email) out.add(email);
  }
  return out;
}

export function isAllowed(email: string, list: string | undefined): boolean {
  return allowedEmails(list).has(email);
}

export type Throttle = "ok" | "cooldown" | "limit";

// Whether another code may be sent, given when the earlier ones were made.
// A code inside the last minute blocks a resend, and five in the last hour
// block any more until the oldest of them is an hour old.
export function throttle(recent: readonly number[], now: number): Throttle {
  const lastHour = recent.filter((at) => at > now - HOUR_MS);
  if (lastHour.some((at) => at > now - RESEND_COOLDOWN_MS)) return "cooldown";
  if (lastHour.length >= HOURLY_LIMIT) return "limit";
  return "ok";
}

export function isCode(value: unknown): value is string {
  return typeof value === "string" && /^\d{6}$/.test(value);
}

// Six digits from the CSPRNG. Draws above the last whole million are thrown
// away rather than wrapped, which would make the low codes slightly likelier.
export function generateCode(): string {
  const draw = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(draw);
    if (draw[0] < CODE_LIMIT) return String(draw[0] % 1_000_000).padStart(6, "0");
  }
}

// 256 bits in base64url, which goes in a cookie without any escaping.
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

// The hash is bound to its challenge, so a leaked row says nothing about any
// other challenge, and the key means a copy of the table cannot be brute-forced.
export function codeHash(secret: string, challengeId: string, code: string): Promise<string> {
  return hmacHex(secret, `${challengeId}:${code}`);
}

// Compares every character whatever the first difference, so the time taken
// does not reveal how much of a secret was right.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || null;
  }
  return null;
}

export function shouldTouch(lastUsed: number, now: number): boolean {
  return now - lastUsed >= SESSION_TOUCH_MS;
}

// Local development only: wrangler dev serves on localhost, and nothing in
// production answers to these names, so dev mode cannot be reached remotely.
export function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}
