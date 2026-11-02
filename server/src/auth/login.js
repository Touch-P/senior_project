// Password check with per-account lockout (stored in admin_users) and a per-IP limit (in memory).
import bcrypt from 'bcrypt';
import { config } from '../config.js';

const IP_WINDOW_MS = 5 * 60 * 1000;
const IP_MAX_FAILS = 20;

/** Compared against when the email is unknown, so response time does not reveal valid accounts. */
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await bcrypt.hash('not-a-real-password', 12));

/** Failure counters for unknown emails (same lockout behaviour as real accounts → no user enumeration). */
const ghostFails = new Map();
/** Failed attempts per client IP: ip -> timestamps */
const ipFails = new Map();

function noteIpFail(ip, now) {
  const list = (ipFails.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  list.push(now);
  ipFails.set(ip, list);
  if (ipFails.size > 5000) ipFails.delete(ipFails.keys().next().value);
}
const ipBlocked = (ip, now) => (ipFails.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS).length >= IP_MAX_FAILS;

/** For tests. */
export function resetLoginLimits() { ghostFails.clear(); ipFails.clear(); }

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ email: string, password: string, ip?: string }} input
 * @returns {Promise<
 *   | { ok: true, user: { user_id: number, email: string, display_name: string, initials: string, role: string } }
 *   | { ok: false, code: 'INVALID_CREDENTIALS', attemptsLeft: number }
 *   | { ok: false, code: 'LOCKED', lockedUntil: number }
 *   | { ok: false, code: 'RATE_LIMITED' }>}
 */
export async function attemptLogin(db, { email, password, ip = 'unknown' }) {
  const now = Date.now();
  const max = config.LOGIN_MAX_ATTEMPTS;
  if (ipBlocked(ip, now)) return { ok: false, code: 'RATE_LIMITED' };

  const key = email.trim().toLowerCase();
  const user = db.prepare(`SELECT user_id, email, password_hash, display_name, initials, role, failed_attempts,
                                  locked_until_ms, is_active FROM admin_users WHERE email = ?`).get(key);

  if (!user || !user.is_active) {
    await bcrypt.compare(password, await getDummyHash());
    noteIpFail(ip, now);
    const g = ghostFails.get(key) ?? { fails: 0, lockedUntil: 0 };
    if (g.lockedUntil > now) return { ok: false, code: 'LOCKED', lockedUntil: g.lockedUntil };
    g.fails = g.lockedUntil && g.lockedUntil <= now ? 1 : g.fails + 1;
    g.lockedUntil = g.fails >= max ? now + config.LOGIN_LOCK_MS : 0;
    ghostFails.set(key, g);
    if (ghostFails.size > 5000) ghostFails.delete(ghostFails.keys().next().value);
    return g.lockedUntil ? { ok: false, code: 'LOCKED', lockedUntil: g.lockedUntil }
      : { ok: false, code: 'INVALID_CREDENTIALS', attemptsLeft: max - g.fails };
  }

  if (user.locked_until_ms && user.locked_until_ms > now) {
    return { ok: false, code: 'LOCKED', lockedUntil: user.locked_until_ms };
  }

  if (await bcrypt.compare(password, user.password_hash)) {
    db.prepare(`UPDATE admin_users SET failed_attempts = 0, locked_until_ms = NULL, last_login_at = CURRENT_TIMESTAMP
                WHERE user_id = ?`).run(user.user_id);
    const { user_id, display_name, initials, role } = user;
    return { ok: true, user: { user_id, email: user.email, display_name, initials, role } };
  }

  noteIpFail(ip, now);
  // a lock that has expired starts a fresh count
  const fails = (user.locked_until_ms && user.locked_until_ms <= now ? 0 : user.failed_attempts) + 1;
  const lockedUntil = fails >= max ? now + config.LOGIN_LOCK_MS : null;
  db.prepare('UPDATE admin_users SET failed_attempts = ?, locked_until_ms = ? WHERE user_id = ?')
    .run(lockedUntil ? 0 : fails, lockedUntil, user.user_id);
  return lockedUntil ? { ok: false, code: 'LOCKED', lockedUntil } : { ok: false, code: 'INVALID_CREDENTIALS', attemptsLeft: max - fails };
}
