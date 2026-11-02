// Current contents of a shopping session, in the cart_update shape of instruction 2.6.
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} sessionId
 * @param {{ state?: 'stable'|'updating', frameSeq?: number|null }} [opts]
 */
export function cartSnapshot(db, sessionId, { state = 'stable', frameSeq = null } = {}) {
  const s = db.prepare(`SELECT s.session_id, s.status, s.started_at_ms, s.ended_at_ms, c.label AS cart
                        FROM shopping_sessions s JOIN carts c USING (cart_id) WHERE s.session_id = ?`).get(sessionId);
  if (!s) return null;
  const items = db.prepare(`SELECT h.product_id, p.class_name, p.name_th AS name, p.image_path AS image,
                                   h.qty, h.unit_price, h.valid_from_ms AS since_ms
                            FROM cart_item_history h JOIN products p USING (product_id)
                            WHERE h.session_id = ? AND h.is_current = 1 AND h.qty > 0
                            ORDER BY h.valid_from_ms DESC`).all(sessionId)
    .map((i) => ({ ...i, subtotal: round2(i.qty * (i.unit_price ?? 0)) }));
  return {
    type: 'cart_update',
    session_id: s.session_id,
    cart: s.cart,
    status: s.status,
    state,
    items,
    item_count: items.reduce((n, i) => n + i.qty, 0),
    total: round2(items.reduce((n, i) => n + i.subtotal, 0)),
    started_at_ms: s.started_at_ms,
    frame_seq: frameSeq,
    t_server_sent: Date.now(),
  };
}
