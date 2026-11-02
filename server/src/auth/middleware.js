import { HttpError } from '../http/errors.js';
import { parseCookies } from '../http/security.js';
import { COOKIE_NAME, getSessionUser } from './sessions.js';

/** Attach req.user / req.sid from the session cookie (does not reject). */
export function loadUser(db) {
  return (req, res, next) => {
    const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
    req.sid = sid;
    req.user = sid ? getSessionUser(db, sid) : null;
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบ'));
  next();
}

/**
 * Allow only the given role. Checked on the server for every protected route;
 * the UI's locked buttons are only a convenience.
 * @param {'admin'|'staff'} role
 */
export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบ'));
    if (req.user.role !== role) return next(new HttpError(403, 'FORBIDDEN', `ทำรายการนี้ได้เฉพาะ ${role}`));
    next();
  };
}
