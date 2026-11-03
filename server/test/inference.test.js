import './setup.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { config } from '../src/config.js';
import { CLASSES_11 } from '../src/db/seed.js';
import { createMockInference, createRealInference, InferenceError } from '../src/pipeline/inferClient.js';
import { expandScenario, loadScenarios, ScenarioSchema } from '../src/pipeline/scenarios.js';
import { syncActiveModel } from '../src/services/models.js';
import { ADMIN, client, startServer } from './helpers.js';

const scenarios = loadScenarios(config.scenariosDir);

describe('scenarios', () => {
  test('every scenario file is valid and uses labels the model knows', () => {
    assert.ok(scenarios.size >= 6, 'one generated scenario per prototype cart');
    for (const sc of scenarios.values()) {
      assert.ok(sc.frames.length > 0, sc.name);
      for (const f of sc.frames) {
        for (const d of f.detections) {
          assert.ok(CLASSES_11.includes(d.class_name), `${sc.name}: unknown class ${d.class_name}`);
          for (const v of [d.x1, d.y1, d.x2, d.y2]) assert.ok(v >= 0 && v <= 1, `${sc.name}#${f.i}: box outside 0-1`);
          assert.ok(d.x2 > d.x1 && d.y2 > d.y1);
        }
      }
    }
    assert.equal([...scenarios.values()].filter((s) => s.default).length, 1, 'exactly one default scenario');
  });

  test('expansion is deterministic, interpolates motion and keeps object ids stable', () => {
    const sc = ScenarioSchema.parse({
      name: 'unit', fps: 10, jitter: 0.01, seed: 42,
      timeline: [
        { frames: 2, objects: [] },
        { frames: 4, objects: [{ id: 'a', class_name: 'lay_big_ori', conf: 0.9, box: [0.2, 0.2, 0.4, 0.4], from: [0.2, 1.0, 0.4, 1.2] }] },
        { frames: 3, objects: [{ id: 'a', class_name: 'lay_big_ori', conf: 0.9, box: [0.2, 0.2, 0.4, 0.4] },
          { id: 'b', class_name: 'lay_big_nori', conf: 0.8, box: [0.5, 0.5, 0.7, 0.7] }] },
      ],
    });
    const a = expandScenario(sc), b = expandScenario(sc);
    assert.deepEqual(a, b);
    assert.equal(a.length, 9);
    assert.equal(a[2].t_ms, 200);
    assert.equal(a[1].detections.length, 0);
    // first frame of the slide-in: 3/4 of the way from below the frame, so still near the bottom edge
    assert.ok(a[2].detections[0].y1 > 0.7);
    assert.ok(Math.abs(a[5].detections[0].y1 - 0.2) < 0.02, 'last frame of the segment reaches the target box');
    assert.deepEqual(a.at(-1).detections.map((d) => [d.id, d.track_id]), [['a', 1], ['b', 2]]);
  });

  test('rejects malformed scenarios', () => {
    assert.throws(() => ScenarioSchema.parse({ name: 'Bad Name', timeline: [{ frames: 1, objects: [] }] }));
    assert.throws(() => ScenarioSchema.parse({ name: 'x', timeline: [] }));
  });
});

describe('mock inference', () => {
  const active = () => ({ name: 'yolo11s-s0-20261025', names: CLASSES_11 });

  test('plays the scenario of each cart frame by frame and loops', async () => {
    const mock = createMockInference({ scenarios, active });
    const sc = scenarios.get('cart-a-08');
    const got = [];
    for (let i = 0; i < sc.frames.length + 2; i++) got.push(await mock.infer({ cart: 'A-08', seq: i }));
    assert.equal(got[0].scenario, 'cart-a-08');
    assert.equal(got[0].model, 'yolo11s-s0-20261025');
    assert.deepEqual(got.map((r) => r.frame).slice(0, 3), [0, 1, 2]);
    assert.equal(got.at(-1).frame, 1, 'loops back to the start');
    // A-08 event log: lay_big_nori goes in and out again (abandon) before koalas arrives
    const seen = got.slice(0, sc.frames.length).map((r) => r.detections.map((d) => d.class_name).sort().join(','));
    const abandoned = seen.findIndex((s) => s.includes('lay_big_nori'));
    assert.ok(abandoned > 0 && !seen[abandoned + 30].includes('lay_big_nori'), 'lay_big_nori leaves again');
    const full = got[sc.frames.findIndex((f) => f.note === 'final basket')];
    assert.deepEqual(full.detections.map((d) => d.class_name).sort(), ['bengbeng_pack12', 'koalas_march_chocolate', 'rosdee_mid_pork']);
    assert.equal(full.detections[0].track_id, undefined, 'no track ids unless track=true');
    assert.ok(Number.isFinite(full.t_infer_start_ms) && full.t_infer_end_ms >= full.t_infer_start_ms);
  });

  test('carts have independent cursors; unknown carts use the default scenario; reset restarts', async () => {
    const mock = createMockInference({ scenarios, active });
    await mock.infer({ cart: 'A-08' }); await mock.infer({ cart: 'A-08' });
    assert.equal((await mock.infer({ cart: 'B-01' })).scenario, 'cart-b-01');
    assert.equal((await mock.infer({ cart: 'B-01' })).frame, 1);
    const other = await mock.infer({ cart: 'C-01' });
    assert.equal(other.scenario, 'cart-a-08');
    assert.equal(other.frame, 0);
    assert.equal(await mock.resetTracks('A-08'), true);
    assert.equal((await mock.infer({ cart: 'A-08' })).frame, 0);
  });

  test('track=true returns stable track ids; MOCK_SCENARIO forces one scenario', async () => {
    const mock = createMockInference({ scenarios, active, force: 'cart-b-01' });
    const frames = [];
    for (let i = 0; i < 60; i++) frames.push(await mock.infer({ cart: 'A-08', track: true }));
    assert.ok(frames.every((r) => r.scenario === 'cart-b-01'));
    const ids = new Map();
    for (const d of frames.flatMap((r) => r.detections)) {
      assert.ok(Number.isInteger(d.track_id));
      if (ids.has(d.class_name)) assert.equal(ids.get(d.class_name), d.track_id);
      ids.set(d.class_name, d.track_id);
    }
    assert.throws(() => createMockInference({ scenarios, active, force: 'nope' }), /not found/);
  });

  test('health reports the active model from the database, device "mock"', async () => {
    const h = await createMockInference({ scenarios, active }).health();
    assert.equal(h.model, 'yolo11s-s0-20261025');
    assert.equal(h.nc, 11);
    assert.equal(h.device, 'mock');
  });
});

/** Fake Python service: lets the tests drive every answer without a GPU. */
function fakeInference() {
  const calls = [];
  const state = { model: 'yolov8s-s0-20261025', delayMs: 0, inferStatus: 200, inferBody: null, loadStatus: 200 };
  const names = CLASSES_11;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), type: req.headers['content-type'], bytes: body.length, body });
    const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof json === 'string' ? json : JSON.stringify(json)); };
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (url.pathname === '/health') return send(200, { status: 'ok', model: state.model, names, nc: names.length, device: 'cuda:0' });
    if (url.pathname === '/infer') {
      if (state.inferBody !== null) return send(state.inferStatus, state.inferBody);
      return send(200, { model: state.model, infer_ms: 9.5, detections: [
        { class_name: 'lay_big_ori', class_id: 5, conf: 0.91, x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4, ...(url.searchParams.get('track') ? { track_id: 7 } : {}) }] });
    }
    if (url.pathname === '/model') {
      if (state.loadStatus !== 200) return send(state.loadStatus, { error: 'MODEL_LOAD_FAILED', message: "AttributeError: Can't get attribute 'DSC3k2'" });
      const { name } = JSON.parse(body.toString());
      state.model = name;
      return send(200, { model: name, names, load_ms: 50, warmup_ms: 12 });
    }
    if (url.pathname.startsWith('/tracks/')) return send(200, { reset: true });
    send(404, { error: 'NOT_FOUND' });
  });
  return {
    calls, state,
    async start() { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${server.address().port}`; },
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  };
}

describe('real inference client', () => {
  let fake, url;
  before(async () => { fake = fakeInference(); url = await fake.start(); });
  after(() => fake.close());

  test('sends the raw JPEG with cart and seq, returns detections and server timestamps', async () => {
    const inf = createRealInference({ url, timeoutMs: 1000 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const r = await inf.infer({ cart: 'A-08', seq: 41, jpeg, track: true });
    const call = fake.calls.at(-1);
    assert.equal(call.type, 'image/jpeg');
    assert.equal(call.bytes, jpeg.length);
    assert.deepEqual(call.query, { cart_id: 'A-08', seq: '41', track: 'true' });
    assert.equal(r.detections[0].class_name, 'lay_big_ori');
    assert.equal(r.detections[0].track_id, 7);
    assert.ok(r.t_infer_end_ms >= r.t_infer_start_ms);
    assert.equal(inf.status().ok, true);
  });

  test('timeout, refused connection and bad responses become InferenceError codes', async () => {
    fake.state.delayMs = 300;
    const slow = createRealInference({ url, timeoutMs: 50 });
    await assert.rejects(slow.infer({ cart: 'A-08', seq: 1, jpeg: Buffer.alloc(4) }), { code: 'INFERENCE_TIMEOUT' });
    assert.equal(slow.status().ok, false);
    assert.equal(slow.status().consecutive_errors, 1);
    fake.state.delayMs = 0;

    const down = createRealInference({ url: 'http://127.0.0.1:1', timeoutMs: 500 });
    await assert.rejects(down.health(), (err) => err instanceof InferenceError && err.code === 'INFERENCE_DOWN');

    const inf = createRealInference({ url, timeoutMs: 1000 });
    fake.state.inferBody = { model: 'x', detections: [{ class_name: 'a' }] };
    await assert.rejects(inf.infer({ cart: 'A-08', seq: 2, jpeg: Buffer.alloc(4) }), { code: 'INFERENCE_BAD_RESPONSE' });
    fake.state.inferBody = 'not json';
    await assert.rejects(inf.infer({ cart: 'A-08', seq: 3, jpeg: Buffer.alloc(4) }), { code: 'INFERENCE_BAD_RESPONSE' });
    fake.state.inferStatus = 400;
    fake.state.inferBody = { error: 'BAD_IMAGE', message: 'cannot decode image' };
    await assert.rejects(inf.infer({ cart: 'A-08', seq: 4, jpeg: Buffer.alloc(4) }), { code: 'INFERENCE_REJECTED', status: 400 });
    assert.equal(inf.status().last_error.code, 'INFERENCE_REJECTED');
    fake.state.inferStatus = 200;
    fake.state.inferBody = null;
  });
});

describe('model switching through the API', () => {
  let fake, srv, admin;
  before(async () => {
    fake = fakeInference();
    const url = await fake.start();
    srv = await startServer({ inference: () => createRealInference({ url, timeoutMs: 1000 }) });
    admin = client(srv.base);
    await admin.login(ADMIN);
  });
  after(async () => { await srv.close(); await fake.close(); });

  const active = () => srv.db.prepare('SELECT name FROM model_versions WHERE is_active = 1').pluck().get();

  test('start-up sync makes the service load the model active in the database', async () => {
    assert.equal(fake.state.model, 'yolov8s-s0-20261025');
    const r = await syncActiveModel({ db: srv.db, inference: srv.inference });
    assert.deepEqual(r, { ok: true, model: 'yolo11s-s0-20261025', loaded: true });
    const load = fake.calls.findLast((c) => c.path === '/model');
    const sent = JSON.parse(load.body.toString());
    assert.equal(sent.name, 'yolo11s-s0-20261025');
    assert.match(sent.path.replaceAll('\\', '/'), /SNP\/yolov11\/outputv11\/yolo11s-s0-20261025\/weights\/best\.pt$/);
    assert.equal(fake.state.model, 'yolo11s-s0-20261025');
  });

  test('activate loads the weights first, then switches the database', async () => {
    const res = await admin.post('/api/admin/models/yolov10s-s0-20261025/activate');
    assert.equal(res.status, 200);
    assert.equal(res.json.from, 'yolo11s-s0-20261025');
    assert.equal(res.json.to, 'yolov10s-s0-20261025');
    assert.equal(res.json.detectable, 11);
    assert.equal(active(), 'yolov10s-s0-20261025');
    assert.equal(fake.state.model, 'yolov10s-s0-20261025');
  });

  test('a model the service cannot load is not activated (422) and the database is unchanged', async () => {
    fake.state.loadStatus = 422;
    const res = await admin.post('/api/admin/models/yolov13s-s0-20261025/activate');
    assert.equal(res.status, 422);
    assert.equal(res.json.error, 'MODEL_LOAD_FAILED');
    assert.match(res.json.detail, /DSC3k2/);
    assert.equal(active(), 'yolov10s-s0-20261025');
    fake.state.loadStatus = 200;
  });

  test('service down: 503 INFERENCE_DOWN, database unchanged; /inference reports the state', async () => {
    await fake.close();
    const res = await admin.post('/api/admin/models/yolo11s-s0-20261025/activate');
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'INFERENCE_DOWN');
    assert.match(res.json.message, /inference/, 'deliberate 5xx errors keep their message');
    assert.equal(active(), 'yolov10s-s0-20261025');
    const st = await admin.get('/api/admin/inference');
    assert.equal(st.status, 200);
    assert.equal(st.json.ok, false);
    assert.equal(st.json.mode, 'real');
    assert.equal(st.json.health, null);
    assert.equal(st.json.last_error.code, 'INFERENCE_DOWN');
    fake = fakeInference(); // a fresh one so after() can close it
    await fake.start();
  });
});

describe('mock mode through the API', () => {
  let srv, admin;
  before(async () => { srv = await startServer(); admin = client(srv.base); await admin.login(ADMIN); });
  after(() => srv.close());

  test('activate works without a GPU and /inference shows the scenarios', async () => {
    const st = await admin.get('/api/admin/inference');
    assert.equal(st.json.mode, 'mock');
    assert.equal(st.json.ok, true);
    assert.ok(st.json.health.scenarios.some((s) => s.name === 'cart-a-08' && s.default));
    const res = await admin.post('/api/admin/models/yolov8s-s0-20261025/activate');
    assert.equal(res.status, 200);
    assert.equal((await admin.get('/api/admin/inference')).json.model, 'yolov8s-s0-20261025');
    const health = await (await fetch(srv.base + '/api/health')).json();
    assert.equal(health.inference_mode, 'mock');
  });
});
