import './setup.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { config } from '../src/config.js';
import { coverage, crossesEdge, distToEdge, iou, pointInPolygon, DEFAULT_ROI } from '../src/pipeline/geometry.js';
import { createMockInference } from '../src/pipeline/inferClient.js';
import { postprocess } from '../src/pipeline/postprocess.js';
import { loadScenarios } from '../src/pipeline/scenarios.js';
import { createTracker, modeOf } from '../src/pipeline/tracker.js';
import { ADMIN, client, openWs, startServer } from './helpers.js';

const det = (class_name, box, conf = 0.9, extra = {}) => ({ class_name, box, conf, accepted: true, in_roi: true, product_id: 1, track_id: null, ...extra });
const A = [0.3, 0.4, 0.5, 0.6];

describe('geometry', () => {
  test('iou, coverage, polygon tests', () => {
    assert.equal(iou(A, A), 1);
    assert.equal(iou(A, [0.6, 0.6, 0.7, 0.7]), 0);
    assert.ok(Math.abs(coverage(A, [0.4, 0.4, 0.6, 0.6]) - 0.5) < 1e-9);
    assert.ok(pointInPolygon([0.5, 0.5], DEFAULT_ROI));
    assert.ok(!pointInPolygon([0.05, 0.2], DEFAULT_ROI));
    assert.ok(distToEdge([0.5, 0.95], DEFAULT_ROI) < 0.05);
    assert.ok(crossesEdge([0.4, 0.9, 0.6, 1.0], DEFAULT_ROI));
    assert.ok(!crossesEdge(A, DEFAULT_ROI));
  });

  test('postprocess maps labels, filters confidence and ROI', () => {
    const catalog = new Map([['lay_big_ori', { product_id: 6 }]]);
    const unknown = [];
    const out = postprocess([
      { class_name: 'lay_big_ori', conf: 0.9, x1: 0.3, y1: 0.4, x2: 0.5, y2: 0.6 },
      { class_name: 'lay_big_ori', conf: 0.5, x1: 0.3, y1: 0.4, x2: 0.5, y2: 0.6 },
      { class_name: 'lay_big_ori', conf: 0.9, x1: 0.8, y1: 0.05, x2: 0.9, y2: 0.2 },
      { class_name: 'mystery', conf: 0.99, x1: 0.3, y1: 0.4, x2: 0.5, y2: 0.6 },
    ], { catalog, confThreshold: 0.7, roi: DEFAULT_ROI, onUnknown: (n) => unknown.push(n) });
    assert.deepEqual(out.map((d) => d.accepted), [true, false, false, false]);
    assert.deepEqual(out.map((d) => d.in_roi), [true, true, false, true]);
    assert.equal(out[0].product_id, 6);
    assert.deepEqual(unknown, ['mystery']);
  });
});

describe('tracker', () => {
  test('modeOf keeps the current value on ties (hysteresis)', () => {
    assert.equal(modeOf([1, 1, 2, 2], 1), 1);
    assert.equal(modeOf([1, 1, 2, 2], 3), 2);
    assert.equal(modeOf([0, 0, 0, 1], 1), 0);
  });

  test('window mode: ADD after K frames, ignores flicker, REMOVE only after 2W frames', () => {
    const t = createTracker({ mode: 'window', window: 8, addK: 3 });
    const frames = (n, dets) => Array.from({ length: n }, () => t.update(dets.map((d) => ({ ...d }))));
    let r = frames(4, [det('lay_big_ori', A)]);
    // mode of [1] > 0 from frame 1; ADD on the 3rd consecutive frame
    assert.deepEqual(r.map((x) => x.changes.length), [0, 0, 1, 0]);
    assert.equal(r[2].stable.get('lay_big_ori'), 1);
    // one missing frame (flicker) changes nothing
    r = frames(1, []);
    assert.equal(r[0].stable.get('lay_big_ori'), 1);
    r = frames(3, [det('lay_big_ori', A)]);
    // gone: mode drops to 0 after more than half the window, REMOVE after 2W = 16 frames below
    r = frames(30, []);
    const removedAt = r.findIndex((x) => x.changes.length);
    assert.ok(removedAt >= 16 && removedAt < 30, `removed at ${removedAt}`);
    assert.equal(r.at(-1).stable.size, 0);
  });

  test('frame mode follows every frame; local_track_id stays with the same box', () => {
    const t = createTracker({ mode: 'frame' });
    const a = det('lay_big_ori', A), b = det('lay_big_ori', [0.32, 0.41, 0.52, 0.61]);
    assert.equal(t.update([a]).changes[0].to, 1);
    t.update([b]);
    assert.equal(b.local_track_id, a.local_track_id);
    assert.equal(t.update([]).changes[0].to, 0);
    const far = det('lay_big_ori', [0.7, 0.7, 0.8, 0.8]);
    t.update([far]);
    assert.notEqual(far.local_track_id, a.local_track_id);
  });

  test('bytetrack mode counts confirmed track ids', () => {
    const t = createTracker({ mode: 'bytetrack', window: 8, addK: 3 });
    const f = (ids) => t.update(ids.map((id, k) => det('mama_cup_ok_hotKR', [0.1 + k * 0.3, 0.4, 0.3 + k * 0.3, 0.6], 0.9, { track_id: id })));
    f([1, 2]); f([1, 2]);
    const r = f([1, 2]);
    assert.equal(r.stable.get('mama_cup_ok_hotKR'), 2);
  });
});

// --------------------------------------------------------------------------- end to end (mock inference)

/** Phone camera stand-in: sends frames and waits for the server's "processed" answer. */
async function camera(wsBase, cart, token) {
  const { ws, next } = await openWs(`${wsBase}/ws/device/${cart}?token=${token}`);
  let seq = 0;
  return {
    ws, next,
    async send(n = 1, { wait = true } = {}) {
      const out = [];
      for (let i = 0; i < n; i++) {
        seq++;
        const header = Buffer.from(JSON.stringify({ seq, t_capture: 1000 + seq, w: 640, h: 480 }) + '\n');
        ws.send(Buffer.concat([header, Buffer.from([0xff, 0xd8, seq & 0xff, 0xff, 0xd9])]));
        await next('ack');
        if (wait) out.push(await next('processed'));
      }
      return out;
    },
    get seq() { return seq; },
  };
}

describe('pipeline end to end (mock inference)', () => {
  let srv, admin, token, scenarios;
  before(async () => {
    scenarios = loadScenarios(config.scenariosDir);
    srv = await startServer({
      pipeline: true,
      inference: (db) => createMockInference({ scenarios, force: 'cart-b-01',
        active: () => ({ name: 'yolo11s-20261104', names: [] }) }),
    });
    admin = client(srv.base);
    await admin.login(ADMIN);
    token = (await admin.post('/api/admin/carts/B-01/device-token')).json.token;
  });
  after(() => srv.close());

  test('without a session frames are acknowledged but nothing is stored', async () => {
    const cam = await camera(srv.wsBase, 'B-01', token);
    const answers = await cam.send(3);
    assert.ok(answers.every((m) => m.idle === true), 'device is told the frames are not used');
    await srv.pipeline.drain();
    assert.equal(srv.db.prepare('SELECT COUNT(*) FROM frames').pluck().get(), 0);
    cam.ws.close();
  });

  test('a session turns the detections into cart items, events, frames and a cart_update', async () => {
    const start = await client(srv.base).post('/api/sessions', { cart: 'B-01' });
    assert.equal(start.status, 201);
    const sessionId = start.json.session_id;
    const display = await openWs(`${srv.wsBase}/ws/display/${sessionId}`);
    await display.next('cart_update'); // initial empty basket
    const cam = await camera(srv.wsBase, 'B-01', token);
    const sc = scenarios.get('cart-b-01');
    const holdAt = sc.frames.findIndex((f) => f.note === 'final basket');
    const processed = await cam.send(holdAt + 1);
    assert.equal(processed.length, holdAt + 1);
    await srv.pipeline.drain();

    const items = srv.db.prepare(`SELECT p.class_name, h.qty, h.unit_price FROM cart_item_history h JOIN products p USING (product_id)
                                  WHERE h.session_id = ? AND h.is_current = 1 ORDER BY p.class_name`).all(sessionId);
    assert.deepEqual(items.map((i) => [i.class_name, i.qty]), [['doritos_mid_nacho', 1], ['lay_big_ori', 1]]);
    assert.ok(items.every((i) => i.unit_price > 0), 'price snapshot taken at ADD');

    const events = srv.db.prepare("SELECT event_type, frame_id, confidence_avg FROM cart_events WHERE session_id = ? AND event_type = 'ADD'").all(sessionId);
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.frame_id && e.confidence_avg > 0.7));

    // every processed frame has a row with all server timestamps in order (brief DoD)
    const frames = srv.db.prepare('SELECT * FROM frames WHERE session_id = ? ORDER BY frame_id').all(sessionId);
    assert.equal(frames.length, holdAt + 1);
    for (const f of frames) {
      assert.equal(f.dropped, 0);
      for (const k of ['t_received_ms', 't_infer_start_ms', 't_infer_end_ms', 't_tracker_ms', 't_db_ms', 't_pushed_ms']) assert.ok(f[k], `${k} missing`);
      assert.ok(f.t_received_ms <= f.t_infer_start_ms && f.t_infer_start_ms <= f.t_infer_end_ms && f.t_infer_end_ms <= f.t_tracker_ms
        && f.t_tracker_ms <= f.t_db_ms && f.t_db_ms <= f.t_pushed_ms, `timestamps out of order in frame ${f.seq}`);
      assert.equal(f.t_capture_device_ms, 1000 + f.seq);
      assert.equal(f.width, 640);
    }
    const latency = srv.db.prepare('SELECT COUNT(*) FROM v_frame_latency WHERE session_id = ?').pluck().get(sessionId);
    assert.equal(latency, frames.length);

    // images only for the frames that caused an event
    const withImage = frames.filter((f) => f.image_path);
    assert.equal(withImage.length, 2);
    assert.ok(withImage.every((f) => events.some((e) => e.frame_id === f.frame_id)));
    assert.ok(existsSync(join(config.ROOT, withImage[0].image_path)));
    assert.ok(withImage[0].image_path.startsWith('data/frames/_test/'));
    const dets = srv.db.prepare('SELECT COUNT(*) FROM detections d JOIN frames f USING (frame_id) WHERE f.session_id = ?').pluck().get(sessionId);
    assert.ok(dets > 0);

    // the customer screen got the basket with the frame seq for E2E
    let last;
    for (;;) { try { last = await display.next('cart_update', 300); } catch { break; } }
    assert.equal(last.items.length, 2);
    assert.equal(last.total, Math.round(items.reduce((n, i) => n + i.unit_price * i.qty, 0) * 100) / 100);
    assert.ok(Number.isInteger(last.frame_seq));

    // device metrics land on the frame (device clock only)
    const res = await fetch(`${srv.base}/api/metrics`, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ cart: 'B-01', token, items: [{ seq: cam.seq, rtt_ms: 12.5, e2e_ms: 48.1 }] }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).updated, 1);
    const m = srv.db.prepare('SELECT rtt_ms, e2e_ms FROM frames WHERE session_id = ? AND seq = ?').get(sessionId, cam.seq);
    assert.deepEqual(m, { rtt_ms: 12.5, e2e_ms: 48.1 });
    const bad = await fetch(`${srv.base}/api/metrics`, { method: 'POST', body: JSON.stringify({ cart: 'B-01', token: 'nope', items: [] }) });
    assert.equal(bad.status, 401);

    // customer report keeps the recent frames as evidence
    const fb = await client(srv.base).post(`/api/sessions/${sessionId}/feedback`, { issue_type: 'missing', class_name: 'lay_big_ori' });
    assert.equal(fb.status, 201);
    const row = srv.db.prepare('SELECT frame_id FROM user_feedback WHERE feedback_id = ?').get(fb.json.feedback_id);
    assert.ok(row.frame_id);
    const saved = srv.db.prepare('SELECT COUNT(*) FROM frames WHERE session_id = ? AND image_path IS NOT NULL').pluck().get(sessionId);
    assert.ok(saved > 2 && saved <= 22, `ring buffer frames saved: ${saved}`);
    cam.ws.close();
    display.ws.close();
  });

  test('a full queue drops the oldest frame and records it as dropped', async () => {
    const slow = await startServer({
      pipeline: true,
      inference: () => createMockInference({ scenarios, force: 'cart-b-01', latencyMs: 60, active: () => ({ name: 'yolo11s-20261104', names: [] }) }),
    });
    try {
      const a = client(slow.base);
      await a.login(ADMIN);
      const tk = (await a.post('/api/admin/carts/A-01/device-token')).json.token;
      const sid = (await client(slow.base).post('/api/sessions', { cart: 'A-01' })).json.session_id;
      const cam = await camera(slow.wsBase, 'A-01', tk);
      await cam.send(8, { wait: false }); // burst: much faster than 60 ms per frame
      await slow.pipeline.drain();
      const rows = slow.db.prepare('SELECT dropped, COUNT(*) AS n FROM frames WHERE session_id = ? GROUP BY dropped').all(sid);
      const by = Object.fromEntries(rows.map((r) => [r.dropped, r.n]));
      assert.equal((by[0] ?? 0) + (by[1] ?? 0), 8);
      assert.ok(by[1] >= 4, `dropped ${by[1]}`);
      assert.equal(slow.pipeline.stats().dropped, by[1]);
      cam.ws.close();
    } finally {
      await slow.close();
    }
  });

  test('admins watching a cart get binary frames with boxes; closing the session stops tracking', async () => {
    const sid = srv.db.prepare("SELECT session_id FROM shopping_sessions WHERE status = 'active' AND cart_id = (SELECT cart_id FROM carts WHERE label = 'B-01')").pluck().get();
    const watcher = await openWs(`${srv.wsBase}/ws/admin`, { cookie: admin.cookie });
    const binary = new Promise((resolve) => watcher.ws.on('message', (data, isBinary) => { if (isBinary) resolve(data); }));
    watcher.ws.send(JSON.stringify({ type: 'watch', cart: 'B-01' }));
    await new Promise((r) => setTimeout(r, 50));
    const cam = await camera(srv.wsBase, 'B-01', token);
    await cam.send(2);
    const buf = await binary;
    const nl = buf.indexOf(0x0a);
    const header = JSON.parse(buf.subarray(0, nl).toString());
    assert.equal(header.type, 'frame');
    assert.equal(header.cart, 'B-01');
    assert.ok(Array.isArray(header.detections) && Array.isArray(header.roi));
    assert.equal(buf.subarray(nl + 1)[0], 0xff, 'JPEG follows the header');

    const res = await admin.post(`/api/sessions/${sid}/checkout`, { total_checkout: 0 });
    assert.equal(res.status, 200);
    const before = srv.db.prepare('SELECT COUNT(*) FROM frames').pluck().get();
    await cam.send(2); // still watched: preview keeps working, but nothing is written
    await srv.pipeline.drain();
    assert.equal(srv.db.prepare('SELECT COUNT(*) FROM frames').pluck().get(), before);
    cam.ws.close();
    watcher.ws.close();
  });
});
