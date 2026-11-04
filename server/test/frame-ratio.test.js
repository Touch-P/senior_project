// Aspect ratio from the phone to the Live view: never stretched or cropped (P2.8).
// The model side (letterbox, EXIF, boxes per 4:3 / 3:4 / 1:1 frame) is tested in inference/tests/test_aspect.py.
import './setup.js';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import vm from 'node:vm';
import { config } from '../src/config.js';
import { createMockInference } from '../src/pipeline/inferClient.js';
import { frameSize, jpegSize } from '../src/pipeline/jpeg.js';
import { ADMIN, client, openWs, startServer } from './helpers.js';

/** web/js/frame-geometry.js runs in the browser (device.html); load it the same way, in a fresh global. */
function loadFrameGeometry() {
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(join(config.ROOT, 'web', 'js', 'frame-geometry.js'), 'utf8'), ctx);
  return ctx.SCFrame;
}

/** Smallest JPEG-shaped bytes with a frame header of w × h (SOF0 baseline or SOF2 progressive). No image files in git. */
function fakeJpeg(w, h, sof = 0xc0) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sofSeg = [0xff, sof, 0x00, 0x11, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, ...app0, ...sofSeg, 0xff, 0xd9]);
}

describe('frame size keeps the aspect ratio', () => {
  const { fitLongSide, containRect } = loadFrameGeometry();
  const ratioErr = (a, b) => Math.abs(a.width / a.height - b[0] / b[1]) / (b[0] / b[1]);

  test('device.html: long side 640, short side from the real video ratio (3:4, 4:3, 1:1, 16:9, sensor sizes)', () => {
    const cases = [
      [[1280, 960], [640, 480]], [[960, 1280], [480, 640]], [[720, 720], [640, 640]],
      [[1280, 720], [640, 360]], [[720, 1280], [360, 640]], [[4032, 3024], [640, 480]], [[1920, 1440], [640, 480]],
      [[1600, 1200], [640, 480]], [[1080, 1920], [360, 640]],
    ];
    for (const [[w, h], [ew, eh]] of cases) {
      const s = fitLongSide(w, h, 640);
      assert.deepEqual([s.width, s.height], [ew, eh], `${w}×${h}`);
      assert.ok(ratioErr(s, [w, h]) < 0.002, `${w}×${h} keeps its ratio`);
    }
    // odd sizes: the short side is rounded once, the ratio stays within half a pixel
    for (const [w, h] of [[1001, 777], [777, 1001], [1366, 768], [3000, 4000]]) {
      const s = fitLongSide(w, h, 640);
      assert.equal(Math.max(s.width, s.height), 640);
      const exactShort = Math.min(w, h) * (640 / Math.max(w, h));
      assert.ok(Math.abs(Math.min(s.width, s.height) - exactShort) <= 0.5, `${w}×${h}`);
    }
  });

  test('never upscales; 480 px setting; rotating the phone swaps the sides, ratio unchanged', () => {
    assert.deepEqual({ ...fitLongSide(320, 240, 640) }, { width: 320, height: 240, scale: 1 });
    const l = fitLongSide(1280, 960, 480), p = fitLongSide(960, 1280, 480);
    assert.deepEqual([l.width, l.height, p.width, p.height], [480, 360, 360, 480]);
    assert.equal(fitLongSide(0, 480, 640), null, 'no video yet -> no frame');
  });

  test('containRect places a frame inside a box without stretching (letterbox of the preview)', () => {
    const r = containRect(480, 640, 400, 300); // portrait frame in a landscape box
    assert.ok(Math.abs(r.width / r.height - 0.75) < 1e-9);
    assert.deepEqual([r.height, r.x], [300, (400 - 225) / 2]);
  });
});

describe('server reads the real JPEG size', () => {
  test('jpegSize: fixtures (640×480) and synthetic 3:4 / 1:1 / progressive headers', () => {
    const dir = join(config.ROOT, 'server', 'test', 'fixtures', 'frames');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.jpg'))) {
      assert.deepEqual(jpegSize(readFileSync(join(dir, f))), { width: 640, height: 480 }, f);
    }
    assert.deepEqual(jpegSize(fakeJpeg(480, 640)), { width: 480, height: 640 });
    assert.deepEqual(jpegSize(fakeJpeg(640, 640)), { width: 640, height: 640 });
    assert.deepEqual(jpegSize(fakeJpeg(360, 640, 0xc2)), { width: 360, height: 640 });
    assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 7, 0xff, 0xd9])), null);
    assert.equal(jpegSize(Buffer.from('not a jpeg')), null);
  });

  test('frameSize: the JPEG wins over a wrong header; the header is only a fallback', () => {
    assert.deepEqual(frameSize(fakeJpeg(480, 640), { w: 640, h: 480 }), { w: 480, h: 640 });
    assert.deepEqual(frameSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { w: 640, h: 480 }), { w: 640, h: 480 });
    assert.deepEqual(frameSize(Buffer.from([1]), { w: -1, h: 'x' }), { w: null, h: null });
  });
});

describe('Live view gets the frame ratio and unchanged boxes', () => {
  let srv, admin, token, sessionId;
  before(async () => {
    // one fixed box, so the test knows exactly what the model "returned"
    const fixed = { name: 'fixed', loop: true, infer_ms: 1, frames: [{ detections: [
      { class_name: 'lay_big_ori', conf: 0.9, x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.6 }] }] };
    srv = await startServer({ pipeline: true, cfg: { LIVE_THROTTLE_MS: 0 },
      inference: () => createMockInference({ scenarios: new Map([['fixed', fixed]]), force: 'fixed', active: () => ({ name: 'yolo11s-20261104', names: [] }) }) });
    admin = client(srv.base);
    await admin.login(ADMIN);
    token = (await admin.post('/api/admin/carts/B-01/device-token')).json.token;
    sessionId = (await client(srv.base).post('/api/sessions', { cart: 'B-01' })).json.session_id;
  });
  after(() => srv.close());

  test('3:4, 4:3, 1:1 frames: watch header, latest.jpg and frames.width/height carry the JPEG size; boxes = model boxes', async () => {
    const watcher = await openWs(`${srv.wsBase}/ws/admin`, { cookie: admin.cookie });
    const frames = [];
    watcher.ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const nl = data.indexOf(0x0a);
      frames.push(JSON.parse(data.subarray(0, nl).toString()));
    });
    watcher.ws.send(JSON.stringify({ type: 'watch', cart: 'B-01' }));
    await new Promise((r) => setTimeout(r, 50));
    const cam = await openWs(`${srv.wsBase}/ws/device/B-01?token=${token}`);
    await cam.next('config');

    const sizes = [[480, 640], [640, 480], [640, 640]];
    let seq = 0;
    for (const [w, h] of sizes) {
      seq++;
      // the header deliberately says 640×480: the server must trust the JPEG, not the header
      cam.ws.send(Buffer.concat([Buffer.from(JSON.stringify({ seq, t_capture: seq, w: 640, h: 480 }) + '\n'), fakeJpeg(w, h)]));
      await cam.next('ack');
      await cam.next('processed');
      const res = await fetch(`${srv.base}/api/admin/carts/B-01/latest.jpg`, { headers: { cookie: admin.cookie } });
      assert.deepEqual([res.headers.get('x-frame-width'), res.headers.get('x-frame-height')], [String(w), String(h)]);
    }
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(frames.map((f) => [f.w, f.h]), sizes);

    // boxes are normalised to the frame the phone sent: the server passes them on unchanged whatever the ratio
    for (const f of frames) assert.deepEqual(f.detections.map((d) => d.box), [[0.1, 0.2, 0.4, 0.6]]);

    await srv.pipeline.drain();
    const rows = srv.db.prepare('SELECT seq, width, height FROM frames WHERE session_id = ? ORDER BY seq').all(sessionId);
    assert.deepEqual(rows.map((r) => [r.width, r.height]), sizes);
    cam.ws.close();
    watcher.ws.close();
  });
});
