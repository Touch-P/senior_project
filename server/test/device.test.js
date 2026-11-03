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

  test('staff cannot change the ROI from the phone page', async () => {
    const staff = client(srv.base);
    await staff.login(STAFF);
    const res = await staff.put('/api/admin/carts/A-05/roi', { roi_polygon: [[0, 0], [1, 0], [1, 1]] });
    assert.equal(res.status, 403);
  });
});
