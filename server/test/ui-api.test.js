import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createRealInference } from '../src/pipeline/inferClient.js';
import { ADMIN, client, startServer } from './helpers.js';

describe('endpoints behind the live UI (Phase 8)', () => {
  let srv, admin;
  before(async () => {
    srv = await startServer({ pipeline: true }); // mock inference
    admin = client(srv.base);
    await admin.login(ADMIN);
  });
  after(() => srv.close());

  test('dashboard overview: KPIs for today / 7 / 30 days with the previous period and sessions per hour', async () => {
    await client(srv.base).post('/api/sessions', { cart: 'A-01' });
    for (const range of [0, 1, 2]) {
      const r = (await admin.get(`/api/admin/analytics/overview?range=${range}`)).json;
      assert.equal(r.days, [1, 7, 30][range]);
      assert.equal(r.current.sessions, 1);
      assert.equal(r.per_hour.length, 15);
      assert.ok('cart_accuracy' in r.current && 'previous' in r);
    }
    assert.equal((await admin.get('/api/admin/analytics/overview?range=9')).status, 400);
  });

  test('model switches are listed in /models history (ok and failed)', async () => {
    await admin.post('/api/admin/models/yolov8s-s0-20261025/activate');
    await admin.post('/api/admin/models/yolo11s-s0-20261025/activate');
    const { history } = (await admin.get('/api/admin/models')).json;
    assert.equal(history[0].to, 'yolo11s-s0-20261025');
    assert.equal(history[0].from, 'yolov8s-s0-20261025');
    assert.equal(history[0].status, 'ok');
    assert.equal(history[0].by, 'สมชาย ใจดี');
  });

  test('latency returns 24 p95 buckets for the chart', async () => {
    const r = (await admin.get('/api/admin/latency?window=1h')).json;
    assert.equal(r.series.length, 24);
    assert.ok('carts' in r);
  });

  test('demo playback feeds the real pipeline of the session cart (mock inference only)', async () => {
    const sid = (await client(srv.base).post('/api/sessions', { cart: 'A-07' })).json.session_id;
    const list = (await client(srv.base).get('/api/demo')).json.scenarios;
    assert.ok(list.some((s) => s.name === 'r01-brand-switch'));
    const r = await client(srv.base).post('/api/demo/play', { session_id: sid, scenario: 'r01-brand-switch' });
    assert.equal(r.status, 200);
    assert.equal(r.json.cart, 'A-07');
    await new Promise((res) => setTimeout(res, 3500)); // lay_big_ori enters within the first ~2 s at 4 fps
    const items = srv.db.prepare('SELECT p.class_name FROM cart_item_history h JOIN products p USING (product_id) WHERE session_id = ? AND is_current = 1 AND qty > 0').pluck().all(sid);
    assert.deepEqual(items, ['lay_big_ori']);
    assert.equal((await client(srv.base).post('/api/demo/play', { session_id: sid, scenario: 'nope' })).status, 404);
    assert.equal((await client(srv.base).post('/api/demo/play', { session_id: '00000000-0000-4000-8000-000000000000', scenario: 'r01-brand-switch' })).status, 404);
  });

  test('evidence frames need a login', async () => {
    assert.equal((await client(srv.base).get('/frames/20260101/x/1.jpg')).status, 401);
    assert.equal((await admin.get('/frames/20260101/x/1.jpg')).status, 404);
  });

  test('/api/meta tells the UI whether demo scenarios exist', async () => {
    assert.equal((await client(srv.base).get('/api/meta')).json.demo_scenarios, true);
  });
});

describe('demo is off with real inference', () => {
  test('GET /api/demo is 404 and meta.demo_scenarios false', async () => {
    const srv = await startServer({ pipeline: true, inference: () => createRealInference({ url: 'http://127.0.0.1:1', timeoutMs: 100 }) });
    try {
      assert.equal((await client(srv.base).get('/api/demo')).status, 404);
      assert.equal((await client(srv.base).get('/api/meta')).json.demo_scenarios, false);
    } finally {
      await srv.close();
    }
  });
});
