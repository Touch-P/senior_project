// Shopping session lifecycle: start (QR scan), survey/PDPA, summary code, checkout.
import { randomInt, randomUUID } from 'node:crypto';
import { HttpError } from '../http/errors.js';
import { raiseAlert } from './alerts.js';
import { cartSnapshot } from './cart.js';

/** Resolve a cart from the QR payload (e.g. SC-CART-A-07) or the label typed by the customer. */
export function findCart(db, { qr, cart }) {
  if (qr) return db.prepare('SELECT * FROM carts WHERE qr_code = ?').get(qr.trim());
  return db.prepare('SELECT * FROM carts WHERE label = ? COLLATE NOCASE').get(cart.trim());
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('../ws/hub.js').Hub} hub
 * @param {{ qr?: string, cart?: string }} input
 */
export function startSession(db, hub, input) {
  const cart = findCart(db, input);
  if (!cart) throw new HttpError(404, 'INVALID_QR', 'QR นี้ไม่ใช่รหัสรถเข็นของ Smart Cart');
  if (cart.status === 'maintenance') throw new HttpError(409, 'CART_MAINTENANCE', `รถเข็น ${cart.label} ปิดซ่อมบำรุง`);
  const active = db.prepare("SELECT session_id FROM shopping_sessions WHERE cart_id = ? AND status = 'active'").get(cart.cart_id);
  if (active) throw new HttpError(409, 'CART_IN_USE', `รถเข็น ${cart.label} กำลังถูกใช้งาน`, { cart: cart.label });

  const sessionId = randomUUID();
  const now = Date.now();
  const modelId = db.prepare('SELECT model_id FROM model_versions WHERE is_active = 1').pluck().get() ?? null;
  db.transaction(() => {
    db.prepare(`INSERT INTO shopping_sessions (session_id, cart_id, model_id, status, started_at_ms)
                VALUES (?, ?, ?, 'active', ?)`).run(sessionId, cart.cart_id, modelId, now);
    db.prepare(`INSERT INTO cart_events (session_id, event_type, qty_delta, source, note, occurred_at_ms)
                VALUES (?, 'START', 0, 'customer', ?, ?)`).run(sessionId, `เริ่ม session · สแกน QR รถเข็น ${cart.label}`, now);
    db.prepare("UPDATE carts SET status = 'in_use', updated_at = CURRENT_TIMESTAMP WHERE cart_id = ?").run(cart.cart_id);
  })();
  const store = db.prepare('SELECT name_th FROM stores WHERE store_id = ?').pluck().get(cart.store_id);
  hub.toAdmins({ type: 'live_update', event: 'session_started', cart: cart.label, session_id: sessionId, started_at_ms: now });
  return { session_id: sessionId, cart: cart.label, store, started_at_ms: now, display_ws: `/ws/display/${sessionId}` };
}

/** @returns {object} the session row joined with its cart label */
export function getSession(db, sessionId) {
  const s = db.prepare(`SELECT s.*, c.label AS cart FROM shopping_sessions s JOIN carts c USING (cart_id)
                        WHERE s.session_id = ?`).get(sessionId);
  if (!s) throw new HttpError(404, 'SESSION_NOT_FOUND', 'ไม่พบ session');
  return s;
}

export function requireActive(session) {
  if (session.status !== 'active') throw new HttpError(409, 'SESSION_CLOSED', 'session นี้จบไปแล้ว', { status: session.status });
}

/** PDPA consent and the optional anonymous survey (C-02 to C-04). */
export function updateSession(db, sessionId, patch) {
  const s = getSession(db, sessionId);
  requireActive(s);
  const consent = patch.pdpa_consent ?? Boolean(s.pdpa_consent);
  if ((patch.gender || patch.age_range) && !consent) {
    throw new HttpError(400, 'PDPA_REQUIRED', 'ต้องยินยอม PDPA ก่อนตอบแบบสอบถาม');
  }
  db.prepare(`UPDATE shopping_sessions SET pdpa_consent = ?, gender = COALESCE(?, gender), age_range = COALESCE(?, age_range)
              WHERE session_id = ?`).run(consent ? 1 : 0, patch.gender ?? null, patch.age_range ?? null, sessionId);
  return getSession(db, sessionId);
}

const CHECKOUT_TTL_MS = 10 * 60 * 1000;

/** Customer pressed "จบการซื้อ": issue the code shown as QR on C-07 (session stays active until the cashier confirms). */
export function issueSummary(db, sessionId) {
  const s = getSession(db, sessionId);
  requireActive(s);
  let code = s.checkout_code;
  if (!code) {
    const base = `SC-${sessionId.slice(0, 4)}-${sessionId.slice(-4)}`.toUpperCase();
    code = db.prepare('SELECT 1 FROM shopping_sessions WHERE checkout_code = ?').get(base)
      ? `SC-${String(randomInt(1e8)).padStart(8, '0')}` : base;
    db.prepare('UPDATE shopping_sessions SET checkout_code = ? WHERE session_id = ?').run(code, sessionId);
  }
  return { ...cartSnapshot(db, sessionId), checkout_code: code, expires_at_ms: Date.now() + CHECKOUT_TTL_MS };
}

/**
 * Close a session at the cashier with the POS total (ground truth). Raises CHECKOUT_MISMATCH
 * when the system total differs.
 * @param {{ totalCheckout?: number|null, userId?: number, status?: 'checked_out'|'abandoned'|'timeout' }} opts
 */
export function closeSession(db, hub, sessionId, { totalCheckout = null, userId = null, status = 'checked_out' } = {}) {
  const s = getSession(db, sessionId);
  requireActive(s);
  // let the pipeline finalize pending decisions (presence / reasons) before the totals are taken
  hub.events?.emit('session_closing', { sessionId, cartId: s.cart_id, cart: s.cart, status });
  const snap = cartSnapshot(db, sessionId);
  const now = Date.now();
  const eventType = { checked_out: 'CHECKOUT', abandoned: 'ABANDONED', timeout: 'TIMEOUT' }[status];
  db.transaction(() => {
    db.prepare(`UPDATE shopping_sessions SET status = ?, ended_at_ms = ?, total_auto = ?, total_checkout = ?, item_count = ?
                WHERE session_id = ?`).run(status, now, snap.total, totalCheckout, snap.item_count, sessionId);
    db.prepare(`INSERT INTO cart_events (session_id, event_type, qty_delta, source, note, occurred_at_ms)
                VALUES (?, ?, 0, ?, ?, ?)`)
      .run(sessionId, eventType, userId ? 'staff' : 'system',
        totalCheckout == null ? `ยอดระบบ ${snap.total.toFixed(2)}` : `POS ${totalCheckout.toFixed(2)} · ยอดระบบ ${snap.total.toFixed(2)}`, now);
    db.prepare("UPDATE carts SET status = 'available', updated_at = CURRENT_TIMESTAMP WHERE cart_id = ?").run(s.cart_id);
  })();
  if (totalCheckout != null && Math.abs(totalCheckout - snap.total) >= 0.01) {
    raiseAlert(db, hub, {
      type: 'CHECKOUT_MISMATCH', cartId: s.cart_id, sessionId,
      message: `${s.cart} · ยอดต่างจาก POS ฿${Math.abs(totalCheckout - snap.total).toFixed(2)}`,
      payload: { total_auto: snap.total, total_checkout: totalCheckout },
    });
  }
  const closed = { ...cartSnapshot(db, sessionId), total_checkout: totalCheckout };
  hub.toDisplay(sessionId, closed);
  hub.toAdmins({ type: 'live_update', event: 'session_closed', cart: s.cart, session_id: sessionId, status });
  return closed;
}
