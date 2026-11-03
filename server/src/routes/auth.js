import { Router } from 'express';
import { z } from 'zod';
import { attemptLogin } from '../auth/login.js';
import { requireAuth } from '../auth/middleware.js';
import { COOKIE_NAME, cookieOptions, createSession, destroySession } from '../auth/sessions.js';
import { HttpError, parse } from '../http/errors.js';

const LoginBody = z.object({
  email: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(200),
  remember: z.boolean().optional().default(false),
});

const publicUser = (u) => ({ email: u.email, name: u.display_name, initials: u.initials, role: u.role });

export function authRoutes({ db, log }) {
  const r = Router();

  r.post('/login', async (req, res) => {
    const body = parse(LoginBody, req.body);
    const result = await attemptLogin(db, { email: body.email, password: body.password, ip: req.ip });
    if (!result.ok) {
      log.warn({ email: body.email, ip: req.ip, code: result.code }, 'login failed');
      if (result.code === 'LOCKED') {
        throw new HttpError(423, 'LOCKED', 'บัญชีถูกล็อกชั่วคราว เนื่องจากใส่รหัสผิดหลายครั้ง', { locked_until_ms: result.lockedUntil });
      }
      if (result.code === 'RATE_LIMITED') throw new HttpError(429, 'RATE_LIMITED', 'ลองเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่');
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', { attempts_left: result.attemptsLeft });
    }
    if (req.sid) destroySession(db, req.sid); // rotate: never reuse a pre-login session id
    const sid = createSession(db, result.user.user_id, { remember: body.remember, ip: req.ip, userAgent: req.headers['user-agent'] });
    res.cookie(COOKIE_NAME, sid, cookieOptions(req, body.remember));
    log.info({ email: result.user.email, role: result.user.role }, 'login ok');
    res.json({ user: publicUser(result.user) });
  });

  r.post('/logout', (req, res) => {
    destroySession(db, req.sid);
    res.clearCookie(COOKIE_NAME, { ...cookieOptions(req, false) });
    res.status(204).end();
  });

  r.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));
  // like /me but 200 with user null when logged out (pages that only adapt to the role; no 401 in the console)
  r.get('/status', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }));

  return r;
}
