import { z } from 'zod';

/** Error with an HTTP status and a stable machine-readable code (UI maps codes to Thai text). */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code e.g. CART_IN_USE
   * @param {string} [message]
   * @param {Record<string, unknown>} [extra] merged into the JSON body
   */
  constructor(status, code, message = code, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * Validate input with zod; throws HttpError 400 VALIDATION with the issue list.
 * @template T
 * @param {z.ZodType<T>} schema
 * @param {unknown} data
 * @returns {T}
 */
export function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (r.success) return r.data;
  throw new HttpError(400, 'VALIDATION', 'ข้อมูลไม่ถูกต้อง', {
    issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

/** Central Express error handler: JSON for /api, plain text otherwise. */
export function errorHandler(log) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    let status = err instanceof HttpError ? err.status : err.status ?? err.statusCode ?? 500;
    let code = err instanceof HttpError ? err.code : 'INTERNAL';
    if (err.type === 'entity.parse.failed') { status = 400; code = 'BAD_JSON'; }
    if (err.type === 'entity.too.large') { status = 413; code = 'TOO_LARGE'; }
    if (status >= 500) log.error({ err, method: req.method, url: req.originalUrl }, 'request failed');
    const message = status >= 500 ? 'เกิดข้อผิดพลาดในระบบ' : err.message;
    if (res.headersSent) return;
    res.status(status).json({ error: code, message, ...(err.extra ?? {}) });
  };
}
