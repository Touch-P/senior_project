// Admin console API under /api/admin (login required; admin-only routes use r.admin()).
import { Router } from 'express';
import { relative, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { z } from 'zod';
import { HttpError, parse } from '../http/errors.js';
import { cartSnapshot } from '../services/cart.js';
import { deviceBaseUrl, issueDeviceToken } from '../services/devices.js';
import { activateModel, pick, switchHistory } from '../services/models.js';
import { REASON_LABELS } from '../pipeline/reasons.js';
import { routes } from './registry.js';

const BASE = '/api/admin';
const Label = z.string().regex(/^[A-Za-z]-\d{2}$/, 'รหัสรถเข็นต้องเป็นรูปแบบ A-07');
const Point = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
const RoiBody = z.object({ roi_polygon: z.array(Point).min(3).max(12) }).strict();
const WINDOWS = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 };
const LATEST_MAX_AGE_MS = 10_000;

/** Nearest-rank percentile of a numeric array (ignores null). */
export function percentile(values, p) {
  const v = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
}

/** frames.image_path (relative to the repo) -> URL under /frames (served from FRAMES_DIR to logged-in users only) */
function frameUrl(imagePath) {
  if (!imagePath) return null;
  const rel = relative(config.framesDir, resolve(config.ROOT, imagePath)).split(sep).join('/');
  return rel.startsWith('..') ? null : `/frames/${rel}`;
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
    const row = cartRow(c);
    // Live detail: hidden units (dashed box at last_box) and the reasons of the running session
    if (row.session) Object.assign(row.session, { presence: currentPresence(row.session.session_id), reasons: sessionReasons(row.session.session_id) });
    res.json(row);
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

  // newest camera frame of a cart, from memory (hub.setLatest). The Live grid loads it when a live_update with a
  // new seq arrives, so the page never re-renders per frame. 404 = no recent frame -> the card shows its placeholder.
  r.get('/carts/:label/latest.jpg', (req, res) => {
    const f = hub.getLatest(parse(Label, req.params.label));
    if (!f || Date.now() - f.t > LATEST_MAX_AGE_MS) throw new HttpError(404, 'NO_FRAME', 'ยังไม่มีภาพล่าสุดจากกล้องของรถเข็นนี้');
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Frame-Seq': String(f.seq), 'X-Frame-Time': String(f.t) });
    res.send(f.jpeg);
  });

  // "เพิ่ม device (กล้องมือถือ)" on Admin > Live and `npm run device-link`: rotate the token and return the phone link.
  // base_url = an address the phone can reach (PUBLIC_URL, else https://<LAN IP>:PORT when certs exist, else null
  // and the page uses its own origin, e.g. when the admin itself is opened through the cloudflared URL).
  r.admin('post', '/carts/:label/device-token', (req, res) => {
    res.status(201).json({ ...issueDeviceToken(db, parse(Label, req.params.label)), base_url: deviceBaseUrl() });
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
    for (const e of events) e.image_url = frameUrl(e.image_path);
    res.json({ ...snap, ...s, events, reasons: sessionReasons(sessionId), presence: currentPresence(sessionId) });
  });

  // reasons and per-unit presence (Phase 6) for the Live detail and the Sessions timeline
  const reasonRows = db.prepare(`SELECT r.reason_id, r.reason_code, r.status, r.qty_before, r.qty_after, r.price_delta, r.dwell_ms,
      r.gap_ms, r.decided_at_ms, r.remove_event_id, r.add_event_id, pf.class_name AS from_class, pf.name_th AS from_name,
      pt.class_name AS to_class, pt.name_th AS to_name
    FROM change_reasons r LEFT JOIN products pf ON pf.product_id = r.from_product_id LEFT JOIN products pt ON pt.product_id = r.to_product_id
    WHERE r.session_id = ? ORDER BY r.decided_at_ms, r.reason_id`);
  const sessionReasons = (sessionId) => reasonRows.all(sessionId).map((r) => ({ ...r, label_th: REASON_LABELS[r.reason_code].th, tone: REASON_LABELS[r.reason_code].tone }));
  const presenceRows = db.prepare(`SELECT p.class_name, c.unit_no, c.state, c.change_cause, c.last_box, c.last_seen_ms, c.valid_from_ms,
      o.class_name AS occluded_by
    FROM cart_item_presence c JOIN products p USING (product_id) LEFT JOIN products o ON o.product_id = c.occluded_by_product_id
    WHERE c.session_id = ? AND c.is_current = 1 AND c.state != 'REMOVED' ORDER BY p.class_name, c.unit_no`);
  const currentPresence = (sessionId) => presenceRows.all(sessionId).map((p) => ({ ...p, last_box: p.last_box ? JSON.parse(p.last_box) : null }));

  // ---------------------------------------------------------------- models
  r.get('/models', (req, res) => {
    const models = db.prepare(`SELECT name, family, size, format, imgsz, map50_95, latency_p95_ms, params, gflops,
        conf_threshold, is_active, activated_at FROM model_versions ORDER BY map50_95 DESC, latency_p95_ms`).all()
      .map((m) => ({ ...m, is_active: Boolean(m.is_active) }));
    res.json({ models, history: switchHistory(db) });
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

  // dashboard KPIs: today / 7 days / 30 days, compared with the period before (brief 10: no hard-coded numbers)
  const RANGE_DAYS = [1, 7, 30];
  r.get('/analytics/overview', (req, res) => {
    const q = parse(z.object({ range: z.coerce.number().int().min(0).max(2).default(0) }), req.query);
    const days = RANGE_DAYS[q.range];
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const to = Date.now(), from = startOfToday.getTime() - (days - 1) * 86_400_000, prevFrom = from - days * 86_400_000;
    const kpi = (a, b) => db.prepare(`SELECT COUNT(*) AS sessions, AVG(CASE WHEN status = 'checked_out' THEN total_auto END) AS avg_total,
        AVG(CASE WHEN ended_at_ms IS NOT NULL THEN ended_at_ms - started_at_ms END) AS avg_duration_ms,
        SUM(CASE WHEN status = 'checked_out' AND total_checkout IS NOT NULL THEN 1 ELSE 0 END) AS with_pos,
        SUM(CASE WHEN status = 'checked_out' AND total_checkout IS NOT NULL AND ABS(total_checkout - total_auto) < 0.01 THEN 1 ELSE 0 END) AS pos_match
      FROM shopping_sessions WHERE started_at_ms >= ? AND started_at_ms < ?`).get(a, b);
    const cur = kpi(from, to), prev = kpi(prevFrom, from);
    const acc = (k) => (k.with_pos ? k.pos_match / k.with_pos : null);
    // sessions per hour of day (08-22), averaged over the days of the range
    const hours = db.prepare(`SELECT CAST(strftime('%H', started_at_ms / 1000, 'unixepoch', 'localtime') AS INTEGER) AS h, COUNT(*) AS n
      FROM shopping_sessions WHERE started_at_ms >= ? AND started_at_ms < ? GROUP BY h`).all(from, to);
    const perHour = Array.from({ length: 15 }, (_, i) => Math.round(((hours.find((x) => x.h === i + 8)?.n ?? 0) / days) * 10) / 10);
    const active = db.prepare("SELECT COUNT(*) FROM shopping_sessions WHERE status = 'active'").pluck().get();
    res.json({ range: q.range, from, to, days, active_sessions: active,
      current: { ...cur, cart_accuracy: acc(cur) }, previous: { ...prev, cart_accuracy: acc(prev) }, per_hour: perHour });
  });

  // change reasons (brief 7.6 dashboard card): count per reason + most frequent from -> to pairs
  r.get('/analytics/reasons', (req, res) => {
    const q = parse(z.object({ from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional() }), req.query);
    const from = q.from ?? 0, to = q.to ?? Date.now() + 1;
    const summary = db.prepare(`SELECT reason_code, COUNT(*) AS n, ROUND(AVG(dwell_ms) / 1000.0, 1) AS avg_dwell_s,
        ROUND(AVG(price_delta), 2) AS avg_price_delta
      FROM change_reasons WHERE status = 'final' AND decided_at_ms >= ? AND decided_at_ms < ? GROUP BY reason_code ORDER BY n DESC`).all(from, to)
      .map((r) => ({ ...r, label_th: REASON_LABELS[r.reason_code].th, tone: REASON_LABELS[r.reason_code].tone }));
    const pairs = db.prepare(`SELECT r.reason_code, pf.class_name AS from_class, pf.name_th AS from_name, pt.class_name AS to_class,
        pt.name_th AS to_name, COUNT(*) AS n, ROUND(AVG(r.price_delta), 2) AS avg_price_delta
      FROM change_reasons r JOIN products pf ON pf.product_id = r.from_product_id JOIN products pt ON pt.product_id = r.to_product_id
      WHERE r.status = 'final' AND r.to_product_id != r.from_product_id AND r.decided_at_ms >= ? AND r.decided_at_ms < ?
      GROUP BY r.reason_code, r.from_product_id, r.to_product_id ORDER BY n DESC LIMIT 20`).all(from, to);
    res.json({ summary, pairs });
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
    // 24 buckets of p95 (E2E from the phone when measured, else server_total) for the chart
    const span = WINDOWS[q.window] / 24;
    const series = Array.from({ length: 24 }, (_, i) => {
      const a = since + i * span, b = a + span;
      const inB = rows.filter((x) => x.t_received_ms >= a && x.t_received_ms < b);
      const e2e = inB.map((x) => x.e2e_ms).filter((v) => v != null);
      return { t: a, p95: percentile(e2e.length ? e2e : inB.map((x) => x.server_total_ms), 95), n: inB.length, source: e2e.length ? 'e2e' : 'server' };
    });
    res.json({ window: q.window, frames: totals.frames, dropped: totals.dropped ?? 0, errors: totals.errors ?? 0, stages: stats, series,
      carts: db.prepare('SELECT COUNT(DISTINCT cart_id) FROM frames WHERE t_received_ms >= ?').pluck().get(since) });
  });

  return router;
}
