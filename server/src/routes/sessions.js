// Customer-facing session API (no login: the unguessable session_id is the capability).
// Checkout with the POS total needs a staff or admin login.
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { HttpError, parse } from '../http/errors.js';
import { raiseAlert } from '../services/alerts.js';
import { cartSnapshot } from '../services/cart.js';
import { closeSession, getSession, issueSummary, requireActive, startSession, updateSession } from '../services/sessions.js';

const SessionId = z.uuid();
const StartBody = z.union([
  z.object({ qr: z.string().trim().min(1).max(100) }),
  z.object({ cart: z.string().trim().min(1).max(20) }),
]);
export const GENDERS = ['male', 'female', 'other', 'unspecified'];
export const AGE_RANGES = ['<18', '18-24', '25-34', '35-44', '45-54', '55-64', '65+', 'unspecified'];
const PatchBody = z.object({
  pdpa_consent: z.boolean().optional(),
  gender: z.enum(GENDERS).optional(),
  age_range: z.enum(AGE_RANGES).optional(),
}).strict();
const FeedbackBody = z.object({
  issue_type: z.enum(['missing', 'extra', 'wrong_class', 'wrong_qty']),
  class_name: z.string().max(100).optional(),
  comment: z.string().max(500).optional(),
}).strict();
const CheckoutBody = z.object({ total_checkout: z.number().nonnegative().max(1e6).nullable().optional() }).strict();

export function sessionRoutes({ db, hub }) {
  const r = Router();
  const id = (req) => parse(SessionId, req.params.id);

  r.post('/', (req, res) => res.status(201).json(startSession(db, hub, parse(StartBody, req.body))));

  r.get('/:id', (req, res) => {
    const snap = cartSnapshot(db, id(req));
    if (!snap) throw new HttpError(404, 'SESSION_NOT_FOUND', 'ไม่พบ session');
    res.json(snap);
  });

  r.patch('/:id', (req, res) => {
    const s = updateSession(db, id(req), parse(PatchBody, req.body));
    res.json({ session_id: s.session_id, pdpa_consent: Boolean(s.pdpa_consent), gender: s.gender, age_range: s.age_range });
  });

  r.post('/:id/feedback', (req, res) => {
    const sessionId = id(req);
    const body = parse(FeedbackBody, req.body);
    const s = getSession(db, sessionId);
    requireActive(s);
    const productId = body.class_name
      ? db.prepare('SELECT product_id FROM products WHERE class_name = ?').pluck().get(body.class_name) ?? null : null;
    // frame_id is attached by the pipeline's ring buffer (Phase 5)
    const { lastInsertRowid } = db.prepare(`INSERT INTO user_feedback (session_id, issue_type, product_id, comment, reported_by, created_at_ms)
                                            VALUES (?, ?, ?, ?, 'customer', ?)`)
      .run(sessionId, body.issue_type, productId, body.comment ?? null, Date.now());
    raiseAlert(db, hub, {
      type: 'CUSTOMER_REPORT', cartId: s.cart_id, sessionId,
      message: `${s.cart} · ลูกค้าแจ้ง ${body.issue_type}${body.class_name ? ` · ${body.class_name}` : ''}`,
      payload: { feedback_id: Number(lastInsertRowid) },
    });
    res.status(201).json({ feedback_id: Number(lastInsertRowid) });
  });

  r.post('/:id/summary', (req, res) => res.json(issueSummary(db, id(req))));

  r.post('/:id/checkout', requireAuth, (req, res) => {
    const body = parse(CheckoutBody, req.body);
    res.json(closeSession(db, hub, id(req), { totalCheckout: body.total_checkout ?? null, userId: req.user.user_id }));
  });

  return r;
}
