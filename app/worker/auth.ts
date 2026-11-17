import { EmailMessage } from "cloudflare:email";
import { Hono, type Context, type MiddlewareHandler, type Next } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { Env } from "./env";
import {
  allowedEmails, codeHash, CODE_TTL_MS, COOKIE_MAX_AGE_S, generateCode, generateToken, isAllowed, isCode, isLocalHost,
  MAX_ATTEMPTS, normaliseEmail, readCookie, SESSION_COOKIE, SESSION_IDLE_MS, sha256Hex, shouldTouch, throttle, timingSafeEqual,
} from "./authLogic";

export type Auth =
  | { kind: "person"; email: string; tokenHash: string }
  | { kind: "processor" }
  // ALLOW_UNAUTHENTICATED in local tests, where nobody has signed in.
  | { kind: "dev" };

export type AppEnv = { Bindings: Env; Variables: { auth: Auth } };

type Ctx = Context<{ Bindings: Env }>;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// Signing in needs no session, and signing out must work with a stale one.
const PUBLIC_PATHS = new Set(["/api/auth/request", "/api/auth/verify", "/api/auth/logout"]);
const DEV_SECRET = "study-library-local-development-only";

function devMode(env: Env, request: Request): boolean {
  return env.AUTH_DEV_MODE === "true" && isLocalHost(new URL(request.url).hostname);
}

// Dev mode with no allowlist lets any address in, so local tests need no setup.
function mayUse(email: string, env: Env, request: Request): boolean {
  if (devMode(env, request) && allowedEmails(env.AUTH_ALLOWED_EMAILS).size === 0) return true;
  return isAllowed(email, env.AUTH_ALLOWED_EMAILS);
}

function authSecret(env: Env, request: Request): string | null {
  return env.AUTH_SECRET || (devMode(env, request) ? DEV_SECRET : null);
}

function secureCookie(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

// A signed-in person by their session cookie, or the background processor by
// its service token. Cf-Access headers naming a user are never read, since
// anyone can send them once Cloudflare Access is no longer in front. A
// database error is thrown rather than answered as signed out, so an outage
// does not send every device to the sign-in screen.
export async function authenticate(request: Request, env: Env): Promise<Auth | null> {
  const id = request.headers.get("cf-access-client-id");
  const secret = request.headers.get("cf-access-client-secret");
  if (id && secret && env.PROCESSOR_ACCESS_CLIENT_ID && env.PROCESSOR_ACCESS_CLIENT_SECRET
    && timingSafeEqual(id, env.PROCESSOR_ACCESS_CLIENT_ID) && timingSafeEqual(secret, env.PROCESSOR_ACCESS_CLIENT_SECRET)) {
    return { kind: "processor" };
  }

  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256Hex(token);
    const now = Date.now();
    const row = await env.DB.prepare("SELECT email, last_used_at FROM auth_sessions WHERE token_hash = ?1 AND expires_at > ?2")
      .bind(tokenHash, now).first<{ email: string; last_used_at: number }>();
    // An address taken off the allowlist loses its sessions at once.
    if (row && mayUse(row.email, env, request)) {
      if (shouldTouch(row.last_used_at, now)) {
        // Failing to note the use is no reason to refuse the request.
        await env.DB.prepare("UPDATE auth_sessions SET last_used_at = ?2, expires_at = ?3 WHERE token_hash = ?1")
          .bind(tokenHash, now, now + SESSION_IDLE_MS).run().catch(() => undefined);
      }
      return { kind: "person", email: row.email, tokenHash };
    }
  }

  return env.ALLOW_UNAUTHENTICATED === "true" ? { kind: "dev" } : null;
}

// Answers 401 in JSON, never a redirect, so the app can show its own sign-in
// screen, and 503 when the database cannot say, so nobody is signed out by an outage.
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (PUBLIC_PATHS.has(c.req.path)) return next();
  let auth: Auth | null;
  try {
    auth = await authenticate(c.req.raw, c.env);
  } catch (error) {
    console.error("auth: session lookup failed", error);
    return c.json({ error: "auth_unavailable" }, 503);
  }
  if (!auth) return c.json({ error: "signed_out" }, 401);
  c.set("auth", auth);
  return next();
};

// Kept under its old name for anything that still imports it.
export const requireAccess = requireAuth;

export async function requireProcessor(c: Ctx, next: Next) {
  const expected = c.env.PROCESSOR_KEY;
  const given = c.req.header("x-processor-key");
  if (!expected || !given || !timingSafeEqual(given, expected)) {
    return c.json({ error: "Processor key missing or wrong." }, 401);
  }
  return next();
}

// Sending

type Sender = (to: string, code: string) => Promise<void>;

function message(code: string) {
  return {
    subject: `${code} is your Study Library sign-in code`,
    text:
      `Your Study Library sign-in code is ${code}.\n\n` +
      "It lasts ten minutes and works once. If you did not ask for it, you can ignore this email, " +
      "because nobody can sign in without the code.\n",
  };
}

// The bare address from a From line such as "Study Library <signin@example.com>".
function bareAddress(from: string): string {
  return from.match(/<([^>]+)>/)?.[1] ?? from.trim();
}

// Resend when its key is set, otherwise Cloudflare's send_email binding, which
// only delivers to addresses verified in Email Routing, and that suits an
// allowlist. Null when neither is configured.
function sender(env: Env): Sender | null {
  const from = env.AUTH_EMAIL_FROM;
  if (!from) return null;
  if (env.RESEND_API_KEY) {
    const key = env.RESEND_API_KEY;
    return async (to, code) => {
      const { subject, text } = message(code);
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text }),
      });
      if (!response.ok) throw new Error(`Resend returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    };
  }
  if (env.AUTH_EMAIL) {
    const binding = env.AUTH_EMAIL;
    return async (to, code) => {
      const { subject, text } = message(code);
      const address = bareAddress(from);
      const raw = [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Message-ID: <${crypto.randomUUID()}@${address.split("@")[1] ?? "localhost"}>`,
        `Date: ${new Date().toUTCString()}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        text.replace(/\n/g, "\r\n"),
      ].join("\r\n");
      await binding.send(new EmailMessage(address, to, raw));
    };
  }
  return null;
}

// Work finished after the answer goes, so sending an email takes no longer to
// answer than skipping one, and the timing does not reveal who may sign in.
function later(c: Context<AppEnv>, work: Promise<unknown>) {
  const guarded = work.catch((error) => console.error("auth:", error));
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // Outside the Worker runtime there is no execution context, and the work simply runs on.
  }
}

// Routes, mounted at /api/auth

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/request", async (c) => {
  const dev = devMode(c.env, c.req.raw);
  const secret = authSecret(c.env, c.req.raw);
  const send = sender(c.env);
  // Configuration is checked before the address, so this answer is the same for every address.
  if (!secret || (!send && !dev) || (!dev && allowedEmails(c.env.AUTH_ALLOWED_EMAILS).size === 0)) {
    return c.json({ error: "auth_not_configured" }, 503);
  }
  const body = await c.req.json<{ email?: unknown }>().catch(() => null);
  const email = normaliseEmail(body?.email);
  if (!email) return c.json({ error: "bad_email" }, 400);

  // From here on every outcome answers 202, whether a code was sent or not.
  const accepted = { ok: true };
  if (!mayUse(email, c.env, c.req.raw)) return c.json(accepted, 202);

  const now = Date.now();
  try {
    const recent = await c.env.DB.prepare("SELECT created_at FROM auth_challenges WHERE email = ?1 AND created_at > ?2")
      .bind(email, now - HOUR_MS).all<{ created_at: number }>();
    if (throttle((recent.results ?? []).map((r) => r.created_at), now) !== "ok") return c.json(accepted, 202);

    const id = crypto.randomUUID();
    const code = generateCode();
    await c.env.DB.prepare(
      "INSERT INTO auth_challenges (id, email, code_hash, attempts, created_at, expires_at) VALUES (?1, ?2, ?3, 0, ?4, ?5)",
    ).bind(id, email, await codeHash(secret, id, code), now, now + CODE_TTL_MS).run();

    // Old challenges and sessions are cleared whenever a code is asked for, so the tables stay small.
    later(c, c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM auth_challenges WHERE created_at < ?1").bind(now - DAY_MS),
      c.env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at < ?1").bind(now),
    ]));

    if (!send) {
      // Reached only in dev mode, which needs localhost and AUTH_DEV_MODE, when no email can be sent.
      console.log(`auth: sign-in code for ${email} is ${code}`);
      return c.json({ ...accepted, dev_code: code }, 202);
    }
    later(c, send(email, code));
    return c.json(accepted, 202);
  } catch (error) {
    console.error("auth: could not make a challenge", error);
    return c.json({ error: "auth_unavailable" }, 503);
  }
});

authRoutes.post("/verify", async (c) => {
  const secret = authSecret(c.env, c.req.raw);
  if (!secret) return c.json({ error: "auth_not_configured" }, 503);
  const body = await c.req.json<{ email?: unknown; code?: unknown }>().catch(() => null);
  const email = normaliseEmail(body?.email);
  const code = typeof body?.code === "string" ? body.code.trim() : null;
  if (!email || !isCode(code) || !mayUse(email, c.env, c.req.raw)) return c.json({ error: "invalid_code" }, 400);

  const now = Date.now();
  try {
    // Only the newest code counts, so asking again retires the one before it.
    const latest = await c.env.DB.prepare(
      "SELECT id FROM auth_challenges WHERE email = ?1 AND used_at IS NULL AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1",
    ).bind(email, now).first<{ id: string }>();
    if (!latest) return c.json({ error: "code_expired" }, 400);

    // The attempt is counted before the code is checked, in one statement, so
    // parallel guesses cannot slip past the limit between a read and a write.
    const counted = await c.env.DB.prepare(
      "UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ?1 AND used_at IS NULL AND expires_at > ?2 AND attempts < ?3 RETURNING code_hash",
    ).bind(latest.id, now, MAX_ATTEMPTS).first<{ code_hash: string }>();
    if (!counted) return c.json({ error: "too_many_attempts" }, 400);
    if (!timingSafeEqual(await codeHash(secret, latest.id, code), counted.code_hash)) {
      return c.json({ error: "invalid_code" }, 400);
    }

    // Marking the code used returns a row only once, so one code cannot open two sessions.
    const used = await c.env.DB.prepare("UPDATE auth_challenges SET used_at = ?2 WHERE id = ?1 AND used_at IS NULL RETURNING id")
      .bind(latest.id, now).first<{ id: string }>();
    if (!used) return c.json({ error: "invalid_code" }, 400);

    const token = generateToken();
    await c.env.DB.prepare(
      "INSERT INTO auth_sessions (token_hash, email, created_at, expires_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?3)",
    ).bind(await sha256Hex(token), email, now, now + SESSION_IDLE_MS).run();

    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: secureCookie(c.req.raw),
      sameSite: "Lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE_S,
    });
    c.header("Cache-Control", "no-store");
    return c.json({ email });
  } catch (error) {
    console.error("auth: could not verify", error);
    return c.json({ error: "auth_unavailable" }, 503);
  }
});

authRoutes.get("/session", (c) => {
  const auth = c.get("auth");
  c.header("Cache-Control", "no-store");
  return c.json({ kind: auth.kind, email: auth.kind === "person" ? auth.email : null });
});

authRoutes.post("/logout", async (c) => {
  const token = readCookie(c.req.header("cookie"), SESSION_COOKIE);
  try {
    if (token) await c.env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?1").bind(await sha256Hex(token)).run();
  } catch (error) {
    // The cookie is left alone, so the device is not told it signed out while its session still stands.
    console.error("auth: could not sign out", error);
    return c.json({ error: "auth_unavailable" }, 503);
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: secureCookie(c.req.raw) });
  return c.json({ ok: true });
});

authRoutes.post("/logout-others", async (c) => {
  const auth = c.get("auth");
  if (auth.kind !== "person") return c.json({ error: "person_required" }, 403);
  try {
    const result = await c.env.DB.prepare("DELETE FROM auth_sessions WHERE email = ?1 AND token_hash != ?2")
      .bind(auth.email, auth.tokenHash).run();
    return c.json({ removed: result.meta?.changes ?? 0 });
  } catch (error) {
    console.error("auth: could not sign out other devices", error);
    return c.json({ error: "auth_unavailable" }, 503);
  }
});
