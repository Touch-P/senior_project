import { HttpError } from './errors.js';

/** Content-Security-Policy for the vanilla UI: local scripts only, Google Fonts allowed. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // UI uses style="" attributes
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
}

/**
 * State-changing API calls must send JSON (or no body). Blocks cross-site HTML form posts
 * (urlencoded / multipart / text/plain) on top of the SameSite=strict cookie.
 * @param {string[]} [exempt] paths under /api that accept other bodies (e.g. sendBeacon metrics)
 */
export function jsonOnly(exempt = []) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || exempt.includes(req.path)) return next();
    const type = req.headers['content-type'];
    if (type && !/^application\/json\b/i.test(type)) {
      return next(new HttpError(415, 'JSON_REQUIRED', 'ต้องส่งข้อมูลเป็น application/json'));
    }
    next();
  };
}

/** Log every API request (debug level for static files). */
export function requestLog(log) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const entry = { method: req.method, url: req.originalUrl, status: res.statusCode, ms: Math.round(ms * 10) / 10, user: req.user?.email };
      if (req.originalUrl.startsWith('/api')) log.info(entry, 'request');
      else log.debug(entry, 'static');
    });
    next();
  };
}

/** Parse a Cookie header into an object (no dependency on cookie-parser). */
export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
  }
  return out;
}
