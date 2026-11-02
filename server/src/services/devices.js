// Camera device tokens: the admin issues a token per cart; the phone presents it on /ws/device/{cart}.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../http/errors.js';

const hashToken = (token) => createHmac('sha256', config.SESSION_SECRET).update(`device:${token}`).digest('hex');

/** Issue (or rotate) the camera token of a cart. Returns the raw token once; only its HMAC is stored. */
export function issueDeviceToken(db, cartLabel) {
  const cart = db.prepare('SELECT cart_id, store_id, label FROM carts WHERE label = ?').get(cartLabel);
  if (!cart) throw new HttpError(404, 'CART_NOT_FOUND', `ไม่พบรถเข็น ${cartLabel}`);
  const token = randomBytes(24).toString('base64url');
  const existing = db.prepare("SELECT device_id FROM devices WHERE cart_id = ? AND device_type = 'camera'").pluck().get(cart.cart_id);
  if (existing) {
    db.prepare('UPDATE devices SET token_hash = ?, is_active = 1 WHERE device_id = ?').run(hashToken(token), existing);
  } else {
    db.prepare(`INSERT INTO devices (cart_id, store_id, device_type, label, token_hash) VALUES (?, ?, 'camera', ?, ?)`)
      .run(cart.cart_id, cart.store_id, `กล้องรถเข็น ${cart.label}`, hashToken(token));
  }
  return { cart: cart.label, token, url: `/device.html?cart=${encodeURIComponent(cart.label)}&token=${token}` };
}

/** @returns {{ device_id: number, cart_id: number, label: string } | null} */
export function verifyDeviceToken(db, cartLabel, token) {
  if (!token || token.length > 100) return null;
  const row = db.prepare(`SELECT d.device_id, d.token_hash, c.cart_id, c.label FROM devices d JOIN carts c USING (cart_id)
                          WHERE c.label = ? AND d.device_type = 'camera' AND d.is_active = 1 AND d.token_hash IS NOT NULL`).get(cartLabel);
  if (!row) return null;
  const a = Buffer.from(row.token_hash, 'hex'), b = Buffer.from(hashToken(token), 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? { device_id: row.device_id, cart_id: row.cart_id, label: row.label } : null;
}
