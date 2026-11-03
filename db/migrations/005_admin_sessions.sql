-- 005_admin_sessions.sql — server-side login sessions for the admin console.
-- The cookie carries a random session id; only its HMAC (keyed with SESSION_SECRET) is stored,
-- so a leaked database cannot be used to hijack a session. Survives server restarts.
CREATE TABLE admin_sessions (
  sid_hash       TEXT PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES admin_users(user_id) ON DELETE CASCADE,
  remember       INTEGER NOT NULL DEFAULT 0,      -- 1 = "จดจำฉันไว้ในอุปกรณ์นี้" (persistent cookie)
  created_at_ms  INTEGER NOT NULL,
  last_seen_ms   INTEGER NOT NULL,
  expires_at_ms  INTEGER NOT NULL,                -- sliding expiry
  ip             TEXT,
  user_agent     TEXT
);
CREATE INDEX ix_admin_sessions_user ON admin_sessions (user_id);
CREATE INDEX ix_admin_sessions_expiry ON admin_sessions (expires_at_ms);
