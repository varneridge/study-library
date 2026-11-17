import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Context, Next } from "hono";
import type { Env } from "./env";

type Ctx = Context<{ Bindings: Env }>;

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksDomain = "";

// Cloudflare Access sits in front of the whole site. This checks the token it
// adds to every request, so the API stays closed even if Access is switched off.
export async function requireAccess(c: Ctx, next: Next) {
  if (c.env.ALLOW_UNAUTHENTICATED === "true") return next();

  const domain = c.env.ACCESS_TEAM_DOMAIN;
  const audience = c.env.ACCESS_AUD;
  if (!domain || !audience) {
    return c.json({ error: "Cloudflare Access is not configured for this Worker." }, 500);
  }
  const token = c.req.header("cf-access-jwt-assertion");
  if (!token) return c.json({ error: "Not signed in through Cloudflare Access." }, 401);

  if (!jwks || jwksDomain !== domain) {
    jwks = createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`));
    jwksDomain = domain;
  }
  try {
    await jwtVerify(token, jwks, { issuer: `https://${domain}`, audience });
  } catch {
    return c.json({ error: "Cloudflare Access token is not valid." }, 401);
  }
  return next();
}

export async function requireProcessor(c: Ctx, next: Next) {
  const expected = c.env.PROCESSOR_KEY;
  const given = c.req.header("x-processor-key");
  if (!expected || !given || !timingSafeEqual(given, expected)) {
    return c.json({ error: "Processor key missing or wrong." }, 401);
  }
  return next();
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
