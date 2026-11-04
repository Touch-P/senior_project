// Replay a detection scenario through the real tracker + cart model + SQLite (in memory), in virtual time.
// Used by the 7.7 tests (server/test/reasons.test.js) and the RQ4 experiment (scripts/rq4-tracker-modes.js).
import { EventEmitter } from 'node:events';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { startSession } from '../services/sessions.js';
import { createSimpleCartModel } from './cartModel.js';
import { DEFAULT_ROI } from './geometry.js';
import { statements } from './persist.js';
import { postprocess } from './postprocess.js';
import { createPresenceModel } from './presenceModel.js';
import { createTracker } from './tracker.js';
import { createWriter } from './writer.js';

/** Fresh in-memory database with the product master, carts and models. */
export async function replayDb() {
  const db = openDb(':memory:');
  migrate(db);
  await seed(db, { probeInference: false });
  return db;
}

/**
 * @param {ReturnType<typeof import('./scenarios.js').loadScenarios> extends Map<any, infer S> ? S : never} sc expanded scenario
 * @param {{ mode?: 'frame'|'window'|'bytetrack', presence?: boolean, window?: number, addK?: number, checkout?: boolean,
 *           fps?: number, refFps?: number,
 *           db?: import('better-sqlite3').Database, t0?: number }} [opts]
 */
export async function replayScenario(sc, opts = {}) {
  const { mode = 'window', presence = true, window = 8, addK = 3 } = opts;
  const db = opts.db ?? await replayDb();
  const messages = [];
  const hub = { events: new EventEmitter(), toAdmins: (m) => messages.push(m), toDisplay() {}, toDevice() {} };
  const label = sc.expect?.cart ?? sc.cart ?? 'A-07';
  const { session_id: sessionId } = startSession(db, hub, { cart: label });
  const cart = db.prepare('SELECT cart_id, store_id, label FROM carts WHERE label = ?').get(label);
  const writer = createWriter(db);
  const cfg = { TRACKER_WINDOW: window, REASON_PAIR_WINDOW_MS: 60_000 };
  const model = (presence ? createPresenceModel : createSimpleCartModel)({ db, writer, hub, cfg, sessionId, cart });
  const tracker = createTracker({ mode, window, addK, refFps: opts.refFps ?? 4 });
  const catalog = new Map(statements(db).catalog.all().map((p) => [p.class_name, p]));
  const t0 = opts.t0 ?? 1_800_000_000_000;
  const confThreshold = db.prepare('SELECT conf_threshold FROM model_versions WHERE is_active = 1').pluck().get() ?? 0.7;

  let last = t0;
  for (const f of sc.frames) {
    const t = t0 + f.t_ms;
    last = t;
    // only ByteTrack mode gets track ids from "inference" (the scenario object ids), as in real mode
    const raw = f.detections.map(({ id, track_id, ...d }) => (mode === 'bytetrack' ? { ...d, track_id } : d));
    const dets = postprocess(raw, { catalog, confThreshold, roi: DEFAULT_ROI });
    // frame times drive the frame-rate scale (1 for the 4-5 fps scenarios); opts.fps = the camera's declared rate
    const tr = tracker.update(dets, t, opts.fps);
    const out = model.update({ job: { t: { received: t }, seq: f.i }, tracker: tr, dets, catalog, roi: DEFAULT_ROI });
    if (out.events.length) writer.now((d) => out.persist(d, null));
    for (const m of out.messages ?? []) messages.push(m);
  }
  model.tick?.(last);
  if (opts.checkout ?? sc.expect?.checkout) model.finalize?.();
  writer.flush();

  const name = (id) => (id == null ? null : db.prepare('SELECT class_name FROM products WHERE product_id = ?').pluck().get(id));
  const result = {
    db, sessionId, messages,
    items: Object.fromEntries(db.prepare(`SELECT p.class_name, h.qty FROM cart_item_history h JOIN products p USING (product_id)
                                          WHERE h.session_id = ? AND h.is_current = 1 AND h.qty > 0`).all(sessionId).map((r) => [r.class_name, r.qty])),
    events: Object.fromEntries(db.prepare(`SELECT event_type, COUNT(*) AS n FROM cart_events WHERE session_id = ? AND event_type IN ('ADD','REMOVE','CORRECTION')
                                           GROUP BY event_type`).all(sessionId).map((r) => [r.event_type, r.n])),
    reasons: db.prepare('SELECT * FROM change_reasons WHERE session_id = ? ORDER BY reason_id').all(sessionId)
      .map((r) => ({ ...r, from: name(r.from_product_id), to: name(r.to_product_id), evidence: JSON.parse(r.evidence ?? '{}') })),
    alerts: db.prepare('SELECT alert_type FROM alerts WHERE session_id = ? ORDER BY alert_id').pluck().all(sessionId),
    presence: db.prepare(`SELECT p.class_name, c.unit_no, c.state, c.change_cause, o.class_name AS occluded_by, c.is_current
                          FROM cart_item_presence c JOIN products p USING (product_id) LEFT JOIN products o ON o.product_id = c.occluded_by_product_id
                          WHERE c.session_id = ? ORDER BY c.presence_id`).all(sessionId),
  };
  return result;
}

/** Compare a replay with the scenario's expectation; returns a list of differences (empty = pass). */
export function checkExpect(sc, r) {
  const e = sc.expect ?? {};
  const diffs = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (e.items && !same(sortObj(r.items), sortObj(e.items))) diffs.push(`items ${JSON.stringify(r.items)} != ${JSON.stringify(e.items)}`);
  if (e.events) {
    for (const [k, v] of Object.entries(e.events)) if ((r.events[k] ?? 0) !== v) diffs.push(`${k} events ${r.events[k] ?? 0} != ${v}`);
  }
  if (e.reasons) {
    const got = r.reasons.map((x) => ({ code: x.reason_code, from: x.from, ...(x.to && x.to !== x.from ? { to: x.to } : {}), status: x.status }));
    const want = e.reasons.map(({ code, from, to, status }) => ({ code, from, ...(to ? { to } : {}), status }));
    if (!same(got, want)) diffs.push(`reasons ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
    e.reasons.forEach((w, i) => {
      if (w.qty_before != null && r.reasons[i]?.qty_before !== w.qty_before) diffs.push(`qty_before ${r.reasons[i]?.qty_before} != ${w.qty_before}`);
      if (w.qty_after != null && r.reasons[i]?.qty_after !== w.qty_after) diffs.push(`qty_after ${r.reasons[i]?.qty_after} != ${w.qty_after}`);
    });
  }
  if (e.alerts && !same([...r.alerts].sort(), [...e.alerts].sort())) diffs.push(`alerts ${JSON.stringify(r.alerts)} != ${JSON.stringify(e.alerts)}`);
  if (e.occluded) {
    const got = r.presence.filter((p) => p.is_current && p.state === 'OCCLUDED').map((p) => ({ class_name: p.class_name, by: p.occluded_by }));
    if (!same(got, e.occluded)) diffs.push(`occluded ${JSON.stringify(got)} != ${JSON.stringify(e.occluded)}`);
  }
  for (const cls of e.seen_again ?? []) {
    if (!r.presence.some((p) => p.class_name === cls && p.change_cause === 'SEEN_AGAIN')) diffs.push(`${cls} never SEEN_AGAIN`);
  }
  const inRange = (v, [a, b]) => v != null && v >= a && v <= b;
  if (e.dwell_s && !inRange(r.reasons[0]?.dwell_ms / 1000, e.dwell_s)) diffs.push(`dwell ${r.reasons[0]?.dwell_ms / 1000}s not in ${e.dwell_s}`);
  if (e.gap_s && !inRange(r.reasons[0]?.gap_ms / 1000, e.gap_s)) diffs.push(`gap ${r.reasons[0]?.gap_ms / 1000}s not in ${e.gap_s}`);
  return diffs;
}

const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
