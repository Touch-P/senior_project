/**
 * Insert an alert (severity defaults from alert_types) and push it to every admin dashboard.
 * @param {import('better-sqlite3').Database} db
 * @param {import('../ws/hub.js').Hub} hub
 * @param {{ type: string, message: string, cartId?: number|null, sessionId?: string|null, severity?: string, payload?: object }} a
 */
export function raiseAlert(db, hub, { type, message, cartId = null, sessionId = null, severity, payload }) {
  const sev = severity ?? db.prepare('SELECT default_severity FROM alert_types WHERE alert_type = ?').pluck().get(type);
  if (!sev) throw new Error(`Unknown alert type ${type}`);
  const now = Date.now();
  const { lastInsertRowid } = db.prepare(`INSERT INTO alerts (alert_type, severity, cart_id, session_id, message, payload, created_at_ms)
                                          VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(type, sev, cartId, sessionId, message, payload ? JSON.stringify(payload) : null, now);
  const cart = cartId ? db.prepare('SELECT label FROM carts WHERE cart_id = ?').pluck().get(cartId) : null;
  const alert = { alert_id: Number(lastInsertRowid), alert_type: type, severity: sev, cart, session_id: sessionId, message, created_at_ms: now };
  hub?.toAdmins({ type: 'alert', ...alert });
  return alert;
}
