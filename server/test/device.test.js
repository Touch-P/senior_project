import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ADMIN, client, openWs, startServer, STAFF } from './helpers.js';

describe('phone camera (device.html contract)', () => {
  let srv, admin, token;
  before(async () => {
    srv = await startServer({ pipeline: true });
    admin = client(srv.base);
    await admin.login(ADMIN);
    token = (await admin.post('/api/admin/carts/A-05/device-token')).json.token;
  });
  after(() => srv.close());

  test('GET /api/auth/status answers 200 with the role, or user null when logged out', async () => {
    assert.deepEqual((await client(srv.base).get('/api/auth/status')).json, { user: null });
    assert.equal((await admin.get('/api/auth/status')).json.user.role, 'admin');
    const staff = client(srv.base);
    await staff.login(STAFF);
    assert.equal((await staff.get('/api/auth/status')).json.user.role, 'staff');
  });

  test('on connect the phone gets the ROI and whether a session runs; session start/end are pushed', async () => {
    const cam = await openWs(`${srv.wsBase}/ws/device/A-05?token=${token}`);
    const cfg = await cam.next('config');
    assert.equal(cfg.cart, 'A-05');
    assert.equal(cfg.session_active, false);
    assert.equal(cfg.roi_polygon.length, 4);

    const start = await client(srv.base).post('/api/sessions', { cart: 'A-05' });
    assert.deepEqual(await cam.next('session'), { type: 'session', active: true });

    const roi = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
    assert.equal((await admin.put('/api/admin/carts/A-05/roi', { roi_polygon: roi })).status, 200);
    assert.deepEqual((await cam.next('roi_changed')).roi_polygon, roi);

    cam.ws.send(JSON.stringify({ type: 'hello', camera_desc: 'Pixel 7 rear 1280x960', app_version: 'device-1.0.0' }));
    await new Promise((r) => setTimeout(r, 50));
    const dev = srv.db.prepare("SELECT camera_desc, app_version FROM devices d JOIN carts c USING (cart_id) WHERE c.label = 'A-05'").get();
    assert.deepEqual(dev, { camera_desc: 'Pixel 7 rear 1280x960', app_version: 'device-1.0.0' });

    assert.equal((await admin.post(`/api/sessions/${start.json.session_id}/checkout`, {})).status, 200);
    assert.deepEqual(await cam.next('session'), { type: 'session', active: false });
    cam.ws.close();
  });

  test('Live grid: idle frames push live_update {seq, t_server_sent}; latest.jpg serves the newest frame from memory', async () => {
    const issued = (await admin.post('/api/admin/carts/A-06/device-token')).json;
    assert.ok('base_url' in issued, 'device-token answers the phone-reachable origin (or null)');
    const adm = await openWs(`${srv.wsBase}/ws/admin`, { cookie: admin.cookie });
    await adm.next('hello');
    assert.equal((await admin.get('/api/admin/carts/A-06/latest.jpg')).status, 404, 'no frame yet');

    const cam = await openWs(`${srv.wsBase}/ws/device/A-06?token=${issued.token}`);
    await cam.next('config');
    const jpeg = (seq) => Buffer.from([0xff, 0xd8, seq, 0xff, 0xd9]);
    cam.ws.send(Buffer.concat([Buffer.from(JSON.stringify({ seq: 1, t_capture: 1, w: 640, h: 480 }) + '\n'), jpeg(1)]));
    const ack = await cam.next('ack');
    assert.equal(ack.frame_seq, 1);
    let upd;
    do upd = await adm.next('live_update'); while (upd.cart !== 'A-06');
    assert.equal(upd.event, 'frame');
    assert.equal(upd.seq, 1);
    assert.equal(upd.idle, true);
    assert.deepEqual(upd.items, []);
    assert.ok(Math.abs(upd.t_server_sent - Date.now()) < 5000);

    cam.ws.send(Buffer.concat([Buffer.from(JSON.stringify({ seq: 2 }) + '\n'), jpeg(2)]));
    await cam.next('ack');
    const res = await fetch(`${srv.base}/api/admin/carts/A-06/latest.jpg`, { headers: { cookie: admin.cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-frame-seq'), '2');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), jpeg(2));
    assert.equal((await client(srv.base).get('/api/admin/carts/A-06/latest.jpg')).status, 401, 'login required');
    const staff = client(srv.base);
    await staff.login(STAFF);
    assert.equal((await staff.get('/api/admin/carts/A-06/latest.jpg')).status, 200, 'staff may watch Live');

    // PDPA: the frame lives only while the camera is connected
    cam.ws.close();
    let st;
    do st = await adm.next('device_status'); while (st.cart !== 'A-06' || st.connection !== 'disconnected');
    assert.equal((await admin.get('/api/admin/carts/A-06/latest.jpg')).status, 404);
    adm.ws.close();
  });

  test('staff cannot change the ROI from the phone page', async () => {
    const staff = client(srv.base);
    await staff.login(STAFF);
    const res = await staff.put('/api/admin/carts/A-05/roi', { roi_polygon: [[0, 0], [1, 0], [1, 1]] });
    assert.equal(res.status, 403);
  });
});
