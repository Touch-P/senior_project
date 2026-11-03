// Admin console API under /api/admin (login required; admin-only routes use r.admin()).
import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../http/errors.js';
import { cartSnapshot } from '../services/cart.js';
import { issueDeviceToken } from '../services/devices.js';
import { activateModel, pick } from '../services/models.js';
import { routes } from './registry.js';

const BASE = '/api/admin';
const Label = z.string().regex(/^[A-Za-z]-\d{2}$/, 'รหัสรถเข็นต้องเป็นรูปแบบ A-07');
const Point = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
const RoiBody = z.object({ roi_polygon: z.array(Point).min(3).max(12) }).strict();
const WINDOWS = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 };

/** Nearest-rank percentile of a numeric array (ignores null). */
export function percentile(values, p) {
  const v = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
}

export function adminRoutes({ db, hub, inference, log }) {
  const router = Router();
  const r = routes(router, BASE);

  // ---------------------------------------------------------------- live carts
  const openAlert = db.prepare(`SELECT alert_type, severity, message, created_at_ms FROM alerts
                                WHERE cart_id = ? AND resolved_at_ms IS NULL AND acknowledged_at_ms IS NULL
                                ORDER BY created_at_ms DESC LIMIT 1`);
  const cartRow = (c) => {
    const active = db.prepare("SELECT session_id FROM shopping_sessions WHERE cart_id = ? AND status = 'active'").pluck().get(c.cart_id);
    const snap = active ? cartSnapshot(db, active) : null;
    const lastSeen = db.prepare("SELECT MAX(last_seen_ms) FROM devices WHERE cart_id = ? AND device_type = 'camera'").pluck().get(c.cart_id);
    return {
      cart: c.label, cart_status: c.status, roi_polygon: JSON.parse(c.roi_polygon),
      connection: hub.isDeviceConnected(c.label) ? 'connected' : 'disconnected',
      last_frame_ms: lastSeen ?? null,
      session: snap ? { session_id: snap.session_id, started_at_ms: snap.started_at_ms, items: snap.items, item_count: snap.item_count, total: snap.total } : null,
      alert: openAlert.get(c.cart_id) ?? null,
    };
  };

  r.get('/carts', (req, res) => {
    const all = req.query.all === '1';
    const rows = db.prepare('SELECT * FROM carts ORDER BY label').all().map(cartRow)
      .filter((c) => all || c.session || c.connection === 'connected');
    res.json({ carts: rows, counts: { total: rows.length, alert: rows.filter((c) => c.alert).length, disconnected: rows.filter((c) => c.session && c.connection === 'disconnected').length } });
  });

  r.get('/carts/:label', (req, res) => {
    const c = db.prepare('SELECT * FROM carts WHERE label = ?').get(parse(Label, req.params.label));
    if (!c) throw new HttpError(404, 'CART_NOT_FOUND', 'ไม่พบรถเข็น');
    res.json(cartRow(c));
  });

  r.admin('put', '/carts/:label/roi', (req, res) => {
    const label = parse(Label, req.params.label);
    const { roi_polygon } = parse(RoiBody, req.body);
    const { changes } = db.prepare('UPDATE carts SET roi_polygon = ?, updated_at = CURRENT_TIMESTAMP WHERE label = ?')
      .run(JSON.stringify(roi_polygon), label);
    if (!changes) throw new HttpError(404, 'CART_NOT_FOUND', 'ไม่พบรถเข็น');
    hub.toAdmins({ type: 'roi_changed', cart: label, roi_polygon });
    hub.toDevice(label, { type: 'roi_changed', roi_polygon });
    res.json({ cart: label, roi_polygon });
  });

  r.admin('post', '/carts/:label/device-token', (req, res) => {
    res.status(201).json(issueDeviceToken(db, parse(Label, req.params.label)));
  });

  // ---------------------------------------------------------------- sessions
  r.get('/sessions', (req, res) => {
    const q = parse(z.object({
      status: z.enum(['active', 'checked_out', 'abandoned', 'timeout']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(50),
    }), req.query);
    const rows = db.prepare(`SELECT s.session_id, c.label AS cart, s.status, s.started_at_ms, s.ended_at_ms,
        COALESCE(s.ended_at_ms, ?) - s.started_at_ms AS duration_ms, s.item_count, s.total_auto, s.total_checkout
      FROM shopping_sessions s JOIN carts c USING (cart_id)
      WHERE (? IS NULL OR s.status = ?) ORDER BY s.started_at_ms DESC LIMIT ?`)
      .all(Date.now(), q.status ?? null, q.status ?? null, q.limit);
    for (const row of rows) {
      if (row.status === 'active') {
        const snap = cartSnapshot(db, row.session_id);
        Object.assign(row, { item_count: snap.item_count, total_auto: snap.total });
      }
    }
    res.json({ sessions: rows });
  });

  r.get('/sessions/:id', (req, res) => {
    const sessionId = parse(z.uuid(), req.params.id);
    const snap = cartSnapshot(db, sessionId);
    if (!snap) throw new HttpError(404, 'SESSION_NOT_FOUND', 'ไม่พบ session');
    const events = db.prepare(`SELECT e.event_id, e.event_type, e.qty_delta, e.qty_after, e.unit_price, e.confidence_avg,
        e.source, e.note, e.occurred_at_ms, p.class_name, p.name_th, f.image_path
      FROM cart_events e LEFT JOIN products p USING (product_id) LEFT JOIN frames f ON f.frame_id = e.frame_id
      WHERE e.session_id = ? ORDER BY e.occurred_at_ms, e.event_id`).all(sessionId);
    const s = db.prepare('SELECT total_auto, total_checkout, ended_at_ms, checkout_code FROM shopping_sessions WHERE session_id = ?').get(sessionId);
    res.json({ ...snap, ...s, events });
  });

  // ---------------------------------------------------------------- models
  r.get('/models', (req, res) => {
    const models = db.prepare(`SELECT name, family, size, format, imgsz, map50_95, latency_p95_ms, params, gflops,
        conf_threshold, is_active, activated_at FROM model_versions ORDER BY map50_95 DESC, latency_p95_ms`).all()
      .map((m) => ({ ...m, is_active: Boolean(m.is_active) }));
    res.json({ models });
  });

  r.admin('post', '/models/:name/activate', async (req, res) => {
    const name = parse(z.string().max(100), req.params.name);
    res.json(await activateModel({ db, hub, inference, log }, name, req.user));
  });

  // inference service state for the model page (any logged-in role)
  r.get('/inference', async (req, res) => {
    let health = null;
    try { health = await inference.health(); } catch { /* reported through status() */ }
    res.json({ ...pick(inference.status()), health });
  });

  // ---------------------------------------------------------------- alerts
  r.get('/alerts', (req, res) => {
    const open = req.query.open !== '0';
    const alerts = db.prepare(`SELECT a.alert_id, a.alert_type, a.severity, c.label AS cart, a.session_id, a.message,
        a.created_at_ms, a.acknowledged_at_ms, a.resolved_at_ms
      FROM alerts a LEFT JOIN carts c USING (cart_id)
      WHERE (? = 0 OR (a.resolved_at_ms IS NULL AND a.acknowledged_at_ms IS NULL))
      ORDER BY a.created_at_ms DESC LIMIT 100`).all(open ? 1 : 0);
    res.json({ alerts });
  });

  r.post('/alerts/:id/ack', (req, res) => {
    const alertId = parse(z.coerce.number().int().positive(), req.params.id);
    const { changes } = db.prepare(`UPDATE alerts SET acknowledged_by = ?, acknowledged_at_ms = ?
                                    WHERE alert_id = ? AND acknowledged_at_ms IS NULL`).run(req.user.user_id, Date.now(), alertId);
    if (!changes) throw new HttpError(404, 'ALERT_NOT_FOUND', 'ไม่พบ alert หรือรับทราบไปแล้ว');
    hub.toAdmins({ type: 'alert_ack', alert_id: alertId, by: req.user.display_name });
    res.json({ alert_id: alertId });
  });

  // ---------------------------------------------------------------- analytics (instruction 2.6)
  r.get('/analytics/abandon', (req, res) => {
    const q = parse(z.object({ from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional() }), req.query);
    const rows = db.prepare(`SELECT p.product_id, p.class_name, p.name_th, p.image_path,
        COALESCE(SUM(CASE WHEN e.event_type = 'ADD' THEN e.qty_delta END), 0) AS added,
        COALESCE(SUM(CASE WHEN e.event_type = 'REMOVE' THEN -e.qty_delta END), 0) AS removed
      FROM products p LEFT JOIN cart_events e ON e.product_id = p.product_id AND e.source = 'auto'
        AND e.event_type IN ('ADD','REMOVE') AND e.occurred_at_ms >= ? AND e.occurred_at_ms < ?
      GROUP BY p.product_id`).all(q.from ?? 0, q.to ?? Number.MAX_SAFE_INTEGER)
      .map((x) => ({ ...x, abandon_rate: x.added ? Math.round((x.removed / x.added) * 10000) / 10000 : null }))
      .sort((a, b) => (b.abandon_rate ?? -1) - (a.abandon_rate ?? -1));
    res.json({ products: rows });
  });

  r.get('/analytics/cooccurrence', (req, res) => {
    const q = parse(z.object({ min_support: z.coerce.number().min(0).max(1).default(0) }), req.query);
    const rows = db.prepare(`SELECT v.*, pa.class_name AS class_a, pa.name_th AS name_a, pb.class_name AS class_b, pb.name_th AS name_b
      FROM v_cooccurrence v JOIN products pa ON pa.product_id = v.product_a JOIN products pb ON pb.product_id = v.product_b
      WHERE v.support >= ? ORDER BY v.lift DESC, v.sessions_together DESC LIMIT 100`).all(q.min_support);
    res.json({ pairs: rows });
  });

  // ---------------------------------------------------------------- latency (instruction 2.6 / 3.3)
  r.get('/latency', (req, res) => {
    const q = parse(z.object({ window: z.enum(Object.keys(WINDOWS)).default('1h') }), req.query);
    const since = Date.now() - WINDOWS[q.window];
    const rows = db.prepare('SELECT * FROM v_frame_latency WHERE t_received_ms >= ?').all(since);
    const stages = ['queue_ms', 'infer_call_ms', 'infer_model_ms', 'tracker_ms', 'db_ms', 'push_ms', 'server_total_ms', 'rtt_ms', 'e2e_ms'];
    const stats = Object.fromEntries(stages.map((k) => {
      const v = rows.map((r0) => r0[k]);
      return [k, { p50: percentile(v, 50), p95: percentile(v, 95), p99: percentile(v, 99), n: v.filter((x) => x != null).length }];
    }));
    const totals = db.prepare('SELECT COUNT(*) AS frames, SUM(dropped) AS dropped, SUM(error IS NOT NULL) AS errors FROM frames WHERE t_received_ms >= ?').get(since);
    res.json({ window: q.window, frames: totals.frames, dropped: totals.dropped ?? 0, errors: totals.errors ?? 0, stages: stats });
  });

  return router;
}
