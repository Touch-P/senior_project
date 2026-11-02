// Admin login sessions stored in SQLite (table admin_sessions, migration 005).
import { createHmac, randomBytes } from 'node:crypto';
import { config } from '../config.js';

export const COOKIE_NAME = 'sc_sid';
const TOUCH_EVERY_MS = 60_000;

const hashSid = (sid) => createHmac('sha256', config.SESSION_SECRET).update(sid).digest('hex');

/**
 * Cookie flags. `secure` follows the actual connection: always Secure over HTTPS,
 * and only the development HTTP fallback on 127.0.0.1 gets a non-secure cookie.
 * @param {{ secure: boolean }} req
 * @param {boolean} remember persistent cookie ("จดจำฉัน") vs browser-session cookie
 */
export function cookieOptions(req, remember) {
  return {
    httpOnly: true,
    secure: Boolean(req.secure),
    sameSite: 'strict',
    path: '/',
    ...(remember ? { maxAge: config.SESSION_REMEMBER_MS } : {}),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} userId
 * @param {{ remember?: boolean, ip?: string, userAgent?: string }} meta
 * @returns {string} raw session id for the cookie
 */
export function createSession(db, userId, { remember = false, ip, userAgent } = {}) {
  const sid = randomBytes(32).toString('base64url');
  const now = Date.now();
  const ttl = remember ? config.SESSION_REMEMBER_MS : config.SESSION_TTL_MS;
  db.prepare(`INSERT INTO admin_sessions (sid_hash, user_id, remember, created_at_ms, last_seen_ms, expires_at_ms, ip, user_agent)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(hashSid(sid), userId, remember ? 1 : 0, now, now, now + ttl, ip ?? null, userAgent?.slice(0, 300) ?? null);
  return sid;
}

/**
 * Resolve a session id to its active user, extending the sliding expiry at most once a minute.
 * @returns {{ user_id: number, email: string, display_name: string, initials: string, role: 'admin'|'staff' } | null}
 */
export function getSessionUser(db, sid) {
  if (!sid || sid.length > 100) return null;
  const now = Date.now();
  const row = db.prepare(`SELECT s.sid_hash, s.remember, s.last_seen_ms, s.expires_at_ms,
      u.user_id, u.email, u.display_name, u.initials, u.role, u.is_active
    FROM admin_sessions s JOIN admin_users u USING (user_id) WHERE s.sid_hash = ?`).get(hashSid(sid));
  if (!row) return null;
  if (row.expires_at_ms <= now || !row.is_active) {
    db.prepare('DELETE FROM admin_sessions WHERE sid_hash = ?').run(row.sid_hash);
    return null;
  }
  if (now - row.last_seen_ms > TOUCH_EVERY_MS) {
    const ttl = row.remember ? config.SESSION_REMEMBER_MS : config.SESSION_TTL_MS;
    db.prepare('UPDATE admin_sessions SET last_seen_ms = ?, expires_at_ms = ? WHERE sid_hash = ?').run(now, now + ttl, row.sid_hash);
  }
  const { user_id, email, display_name, initials, role } = row;
  return { user_id, email, display_name, initials, role };
}

export function destroySession(db, sid) {
  if (sid) db.prepare('DELETE FROM admin_sessions WHERE sid_hash = ?').run(hashSid(sid));
}

/** Remove expired sessions (called periodically). */
export function purgeExpiredSessions(db) {
  return db.prepare('DELETE FROM admin_sessions WHERE expires_at_ms <= ?').run(Date.now()).changes;
}
