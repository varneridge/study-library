-- Email sign-in, replacing Cloudflare Access. Codes are kept only as an HMAC
-- and session tokens only as a SHA-256 hash, so a copy of either table lets
-- nobody sign in. Times are milliseconds since 1970, as Date.now() gives them.

CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- The resend cooldown, the hourly limit and the newest-code lookup all read by address and time.
CREATE INDEX IF NOT EXISTS auth_challenges_email ON auth_challenges (email, created_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

-- Signing out every other device deletes by address.
CREATE INDEX IF NOT EXISTS auth_sessions_email ON auth_sessions (email);
