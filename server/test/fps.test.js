// Up to 30 fps per phone (P2.8): settings validation, sliding-window sending, time-based ring buffer.
import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createFrameStore } from '../src/pipeline/frameStore.js';
import { createMockInference } from '../src/pipeline/inferClient.js';
import { loadScenarios } from '../src/pipeline/scenarios.js';
import { config } from '../src/config.js';
import { DEVICE_MAX_FPS, DeviceSettings } from '../src/ws/server.js';
import { ADMIN, client, openWs, startServer } from './helpers.js';

const frame = (seq, w = 640, h = 480) =>
  Buffer.concat([Buffer.from(JSON.stringify({ seq, t_capture: seq, w, h }) + '\n'), Buffer.from([0xff, 0xd8, seq & 0xff, 0xff, 0xd9])]);

describe('device settings up to 30 fps', () => {
  test('DeviceSettings accepts 1-30 fps, rejects 0, 31 and fractions', () => {
    assert.equal(DEVICE_MAX_FPS, 30);
    for (const fps of [1, 2, 4, 5, 10, 15, 20, 30]) assert.ok(DeviceSettings.safeParse({ fps, size: 640, quality: 0.7 }).success, `${fps}`);
    for (const fps of [0, 31, 60, 4.5, '30']) assert.ok(!DeviceSettings.safeParse({ fps }).success, `${fps}`);
    assert.ok(!DeviceSettings.safeParse({ size: 100 }).success);
    assert.ok(DeviceSettings.safeParse({}).success, 'all optional (old phones send no settings)');
  });

  let srv, token;
  before(async () => {
    srv = await startServer({ pipeline: true });
    const admin = client(srv.base);
    await admin.login(ADMIN);
    token = (await admin.post('/api/admin/carts/A-09/device-token')).json.token;
  });
  after(() => srv.close());

  test('hello with fps 30 is stored; fps 31 answers BAD_SETTINGS and keeps the device info unchanged', async () => {
    const cam = await openWs(`${srv.wsBase}/ws/device/A-09?token=${token}`);
    await cam.next('config');
    cam.ws.send(JSON.stringify({ type: 'hello', camera_desc: 'phone 30', app_version: 'device-1.2.0', settings: { fps: 30, size: 640, quality: 0.7 } }));
    await new Promise((r) => setTimeout(r, 50));
    const row = () => srv.db.prepare("SELECT camera_desc FROM devices d JOIN carts c USING (cart_id) WHERE c.label = 'A-09'").pluck().get();
    assert.equal(row(), 'phone 30');
    cam.ws.send(JSON.stringify({ type: 'hello', camera_desc: 'phone 31', settings: { fps: 31 } }));
    const err = await cam.next('error');
    assert.equal(err.error, 'BAD_SETTINGS');
    assert.equal(row(), 'phone 30');
    cam.ws.close();
  });

  test('sliding window: 6 frames sent back to back are all acked at once (no stop-and-wait)', async () => {
    const cam = await openWs(`${srv.wsBase}/ws/device/A-09?token=${token}`);
    await cam.next('config');
    for (let seq = 1; seq <= 6; seq++) cam.ws.send(frame(seq));
    const acks = [];
    for (let i = 0; i < 6; i++) acks.push((await cam.next('ack')).frame_seq);
    assert.deepEqual(acks, [1, 2, 3, 4, 5, 6], 'acks arrive in order, one per frame');
    cam.ws.close();
  });
});

describe('ring buffer keeps a time span (5 s) instead of 20 frames', () => {
  const store = () => createFrameStore({ dir: 'unused', root: config.ROOT });
  const fill = (s, fps, seconds) => {
    for (let i = 0; i < fps * seconds; i++) s.push('A-01', { seq: i + 1, jpeg: Buffer.alloc(1), t: 1_000_000 + Math.round((i * 1000) / fps), job: {} });
    return s.recent('A-01');
  };

  test('4 fps: the same 20 frames as before; 30 fps: ~5 s = 151 frames, not 0.67 s', () => {
    assert.equal(fill(store(), 4, 30).length, 21); // 5 s span inclusive at 250 ms = 21 frames (old fixed ring: 20)
    const r30 = fill(store(), 30, 30);
    assert.ok(r30.length >= 150 && r30.length <= 152, `${r30.length}`);
    assert.ok(r30.at(-1).t - r30[0].t <= 5000);
    assert.equal(fill(store(), 2, 30).length, 20, 'slow cameras still keep at least 20 frames');
  });

  test('a report saves ~20 frames spread over the span, oldest and newest included', () => {
    const s = store();
    const r = fill(s, 30, 10);
    const ev = s.evidence(r);
    assert.equal(ev.length, 20);
    assert.equal(ev[0], r[0]);
    assert.equal(ev.at(-1), r.at(-1));
    const short = r.slice(0, 12);
    assert.deepEqual(s.evidence(short), short, 'fewer than 20: all of them');
  });
});

describe('pipeline at 30 fps with ~25 ms inference', () => {
  test('a queue of 2 keeps up: few frames dropped, and the dropped ones are recorded', async () => {
    const scenarios = loadScenarios(config.scenariosDir);
    const srv = await startServer({
      pipeline: true,
      inference: () => createMockInference({ scenarios, force: 'cart-b-01', latencyMs: 25, active: () => ({ name: 'yolo11s-s0-20261025', names: [] }) }),
    });
    try {
      const admin = client(srv.base);
      await admin.login(ADMIN);
      const { token: t } = (await admin.post('/api/admin/carts/B-02/device-token')).json;
      const sessionId = (await client(srv.base).post('/api/sessions', { cart: 'B-02' })).json.session_id;
      const cam = await openWs(`${srv.wsBase}/ws/device/B-02?token=${t}`);
      await cam.next('config');
      const n = 60; // 2 s at 30 fps, paced by a drift-free clock like device.html
      const t0 = performance.now();
      for (let seq = 1; seq <= n; seq++) {
        const wait = t0 + (seq - 1) * (1000 / 30) - performance.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        cam.ws.send(frame(seq));
      }
      let last;
      do last = await cam.next('processed'); while (last.seq !== n); // the last frame is through the pipeline
      await srv.pipeline.drain();
      const st = srv.db.prepare('SELECT COUNT(*) AS n, SUM(dropped) AS d FROM frames WHERE session_id = ?').get(sessionId);
      assert.equal(st.n, n, 'every frame has a row (inferred or dropped)');
      assert.ok(st.d / n < 0.2, `dropped ${st.d}/${n}`);
      cam.ws.close();
    } finally {
      await srv.close();
    }
  });
});
