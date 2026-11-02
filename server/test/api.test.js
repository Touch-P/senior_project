import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { cookieOptions } from '../src/auth/sessions.js';
import { adminOnlyRoutes } from '../src/routes/registry.js';
import { parseFrameMessage } from '../src/ws/server.js';
import { ADMIN, client, openWs, STAFF, startServer } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

describe('auth', () => {
  it('logs in through the server with an httpOnly SameSite=Strict cookie', async () => {
    const c = client(srv.base);
    const res = await c.login(ADMIN);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.user, { email: ADMIN.email, name: 'สมชาย ใจดี', initials: 'สจ', role: 'admin' });
    const cookie = res.setCookie[0];
    assert.match(cookie, /^sc_sid=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.doesNotMatch(cookie, /Secure/i, 'plain HTTP (dev fallback) cannot set a Secure cookie');
    assert.doesNotMatch(cookie, /Max-Age/i, 'without "remember" the cookie ends with the browser session');
    assert.equal((await c.get('/api/auth/me')).json.user.role, 'admin');
    assert.equal(srv.db.prepare('SELECT COUNT(*) FROM admin_sessions').pluck().get() >= 1, true);
    assert.equal(srv.db.prepare('SELECT COUNT(*) FROM admin_sessions WHERE sid_hash = ?').pluck().get(c.cookie.split('=')[1]), 0,
      'raw session id is never stored');
  });

  it('marks the cookie Secure whenever the request came over HTTPS', () => {
    assert.equal(cookieOptions({ secure: true }, false).secure, true);
    assert.equal(cookieOptions({ secure: false }, false).secure, false);
    assert.ok(cookieOptions({ secure: true }, true).maxAge > 0, 'remember me = persistent cookie');
  });

  it('counts wrong passwords and locks the account on the server', async () => {
    const c = client(srv.base);
    const r1 = await c.login({ email: STAFF.email, password: 'wrong' });
    assert.deepEqual([r1.status, r1.json.error, r1.json.attempts_left], [401, 'INVALID_CREDENTIALS', 2]);
    assert.equal((await c.login({ email: STAFF.email, password: 'wrong' })).json.attempts_left, 1);
    const r3 = await c.login({ email: STAFF.email, password: 'wrong' });
    assert.equal(r3.status, 423);
    assert.ok(r3.json.locked_until_ms > Date.now());
    assert.equal((await c.login(STAFF)).status, 423, 'correct password is refused while locked');
    srv.db.prepare('UPDATE admin_users SET locked_until_ms = ? WHERE email = ?').run(Date.now() - 1, STAFF.email);
    assert.equal((await c.login(STAFF)).status, 200, 'works again after the lock expires');
  });

  it('answers unknown emails exactly like wrong passwords (no account enumeration)', async () => {
    const c = client(srv.base);
    const r = await c.login({ email: 'nobody@smartcart.co.th', password: 'x' });
    assert.deepEqual([r.status, r.json.error, r.json.attempts_left], [401, 'INVALID_CREDENTIALS', 2]);
  });

  it('logout destroys the server session', async () => {
    const c = client(srv.base);
    await c.login(ADMIN);
    const stolen = c.cookie;
    assert.equal((await c.post('/api/auth/logout')).status, 204);
    assert.equal((await c.get('/api/auth/me', { cookie: stolen })).status, 401, 'old cookie no longer works');
  });

  it('rejects a forged or missing session', async () => {
    const c = client(srv.base);
    assert.equal((await c.get('/api/admin/carts')).status, 401);
    assert.equal((await c.get('/api/products', { cookie: 'sc_sid=forged' })).status, 401);
  });
});

describe('roles', () => {
  const sample = (path) => path
    .replace(':label', 'A-07').replace(':name', 'yolov8s-s0-20261025').replace(':id', '00000000-0000-4000-8000-000000000000');
  const bodies = { 'PUT /api/admin/carts/:label/roi': { roi_polygon: [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]] } };

  it('registers the admin-only routes', () => {
    assert.ok(adminOnlyRoutes.size >= 3, [...adminOnlyRoutes].join(', '));
  });

  it('staff gets 403 on every admin-only route', async () => {
    const staff = client(srv.base);
    assert.equal((await staff.login(STAFF)).status, 200);
    for (const route of adminOnlyRoutes) {
      const [method, path] = route.split(' ');
      const res = await staff.call(method, sample(path), bodies[route] ?? {});
      assert.equal(res.status, 403, `${route} -> ${res.status}`);
      assert.equal(res.json.error, 'FORBIDDEN');
    }
  });

  it('admin passes the role check on every admin-only route', async () => {
    const admin = client(srv.base);
    await admin.login(ADMIN);
    for (const route of adminOnlyRoutes) {
      const [method, path] = route.split(' ');
      const res = await admin.call(method, sample(path), bodies[route] ?? {});
      assert.ok(![401, 403].includes(res.status), `${route} -> ${res.status}`);
    }
    // the loop activated another model; restore the default for later tests
    assert.equal((await admin.post('/api/admin/models/yolo11s-s0-20261025/activate')).status, 200);
  });

  it('staff can still read shared pages', async () => {
    const staff = client(srv.base);
    await staff.login(STAFF);
    for (const p of ['/api/products', '/api/admin/carts', '/api/admin/sessions', '/api/admin/models', '/api/admin/alerts',
      '/api/admin/analytics/abandon', '/api/admin/analytics/cooccurrence', '/api/admin/latency?window=1h']) {
      assert.equal((await staff.get(p)).status, 200, p);
    }
    const products = (await staff.get('/api/products')).json;
    assert.deepEqual(products.counts, { total: 20, in_model: 11 });
  });
});

describe('request hygiene', () => {
  it('requires JSON for state-changing API calls (blocks cross-site form posts)', async () => {
    const c = client(srv.base);
    const res = await c.call('POST', '/api/sessions', 'cart=A-01', { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(res.status, 415);
  });

  it('validates input with readable errors and sends security headers', async () => {
    const admin = client(srv.base);
    await admin.login(ADMIN);
    const bad = await admin.put('/api/admin/carts/A-07/roi', { roi_polygon: [[0, 0], [2, 0]] });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'VALIDATION');
    assert.match(bad.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(bad.headers.get('x-content-type-options'), 'nosniff');
  });

  it('serves the prototype UI and public meta from the database', async () => {
    const page = await fetch(srv.base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<div id="app">/);
    const meta = await (await fetch(srv.base + '/api/meta')).json();
    assert.equal(meta.products, 20);
    assert.equal(meta.products_in_model, 11);
    assert.equal(meta.active_model.name, 'yolo11s-s0-20261025');
  });
});

describe('shopping session flow', () => {
  it('start → survey → feedback → summary → checkout at the cashier', async () => {
    const c = client(srv.base);
    const start = await c.post('/api/sessions', { qr: 'SC-CART-A-07' });
    assert.equal(start.status, 201);
    const id = start.json.session_id;
    assert.equal(start.json.cart, 'A-07');
    assert.equal((await c.post('/api/sessions', { cart: 'a-07' })).json.error, 'CART_IN_USE');
    assert.equal((await c.post('/api/sessions', { qr: 'NOT-A-CART' })).json.error, 'INVALID_QR');

    const snap = (await c.get(`/api/sessions/${id}`)).json;
    assert.deepEqual([snap.type, snap.state, snap.total, snap.items.length], ['cart_update', 'stable', 0, 0]);

    assert.equal((await c.patch(`/api/sessions/${id}`, { gender: 'female' })).json.error, 'PDPA_REQUIRED');
    const ok = await c.patch(`/api/sessions/${id}`, { pdpa_consent: true, gender: 'female', age_range: '25-34' });
    assert.deepEqual(ok.json, { session_id: id, pdpa_consent: true, gender: 'female', age_range: '25-34' });

    assert.equal((await c.post(`/api/sessions/${id}/feedback`, { issue_type: 'wrong_qty', class_name: 'lay_big_ori' })).status, 201);
    assert.equal(srv.db.prepare("SELECT COUNT(*) FROM alerts WHERE alert_type = 'CUSTOMER_REPORT'").pluck().get(), 1);

    const summary = (await c.post(`/api/sessions/${id}/summary`)).json;
    assert.match(summary.checkout_code, /^SC-[0-9A-F]{4}-[0-9A-F]{4}$/);

    // simulate one item the pipeline would have added (Phase 5), then checkout with a different POS total
    const pid = srv.db.prepare("SELECT product_id FROM products WHERE class_name = 'lay_big_ori'").pluck().get();
    srv.db.prepare('INSERT INTO cart_item_history (session_id, product_id, qty, unit_price, valid_from_ms) VALUES (?, ?, 2, 31, ?)').run(id, pid, Date.now());
    assert.equal((await c.post(`/api/sessions/${id}/checkout`, { total_checkout: 70 })).status, 401, 'customer cannot close');

    const staff = client(srv.base);
    await staff.login(STAFF);
    const closed = await staff.post(`/api/sessions/${id}/checkout`, { total_checkout: 70 });
    assert.equal(closed.status, 200);
    assert.deepEqual([closed.json.status, closed.json.total, closed.json.total_checkout], ['checked_out', 62, 70]);
    const row = srv.db.prepare('SELECT status, total_auto, total_checkout, item_count FROM shopping_sessions WHERE session_id = ?').get(id);
    assert.deepEqual(row, { status: 'checked_out', total_auto: 62, total_checkout: 70, item_count: 2 });
    assert.equal(srv.db.prepare("SELECT COUNT(*) FROM alerts WHERE alert_type = 'CHECKOUT_MISMATCH'").pluck().get(), 1);
    assert.equal(srv.db.prepare("SELECT status FROM carts WHERE label = 'A-07'").pluck().get(), 'available');
    assert.equal((await c.post('/api/sessions', { cart: 'A-07' })).status, 201, 'cart can be used again');

    const timeline = (await staff.get(`/api/admin/sessions/${id}`)).json.events.map((e) => e.event_type);
    assert.deepEqual(timeline, ['START', 'CHECKOUT']);
  });
});

describe('websockets', () => {
  it('/ws/admin needs a login and receives live updates', async () => {
    await assert.rejects(openWs(`${srv.wsBase}/ws/admin`), { status: 401 });
    const admin = client(srv.base);
    await admin.login(ADMIN);
    await assert.rejects(openWs(`${srv.wsBase}/ws/admin`, { cookie: admin.cookie, origin: 'https://evil.example' }), { status: 403 });
    const { ws, next } = await openWs(`${srv.wsBase}/ws/admin`, { cookie: admin.cookie });
    assert.equal((await next('hello')).role, 'admin');
    await client(srv.base).post('/api/sessions', { cart: 'B-01' });
    const live = await next('live_update');
    assert.deepEqual([live.event, live.cart], ['session_started', 'B-01']);
    ws.close();
  });

  it('/ws/display/{session} gets the cart immediately and on checkout', async () => {
    const id = (await client(srv.base).post('/api/sessions', { cart: 'C-01' })).json.session_id;
    await assert.rejects(openWs(`${srv.wsBase}/ws/display/00000000-0000-4000-8000-000000000000`), { status: 404 });
    const { ws, next } = await openWs(`${srv.wsBase}/ws/display/${id}`);
    const first = await next('cart_update');
    assert.deepEqual([first.session_id, first.status, first.total], [id, 'active', 0]);
    const staff = client(srv.base);
    await staff.login(STAFF);
    await staff.post(`/api/sessions/${id}/checkout`, {});
    assert.equal((await next('cart_update')).status, 'checked_out');
    ws.close();
  });

  it('/ws/device/{cart} needs the device token and acks binary frames', async () => {
    const admin = client(srv.base);
    await admin.login(ADMIN);
    const { token, url } = (await admin.post('/api/admin/carts/A-02/device-token')).json;
    assert.match(url, /^\/device\.html\?cart=A-02&token=/);
    await assert.rejects(openWs(`${srv.wsBase}/ws/device/A-02?token=wrong`), { status: 401 });

    const { ws, next } = await openWs(`${srv.wsBase}/ws/device/A-02?token=${token}`);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    ws.send(Buffer.concat([Buffer.from(JSON.stringify({ seq: 7, t_capture: 123.4, w: 640, h: 480 }) + '\n'), jpeg]));
    const ack = await next('ack');
    assert.equal(ack.seq, 7);
    assert.ok(Math.abs(ack.server_ts - Date.now()) < 5000);
    ws.send(JSON.stringify({ type: 'ping' }));
    assert.equal((await next('pong')).type, 'pong');
    assert.equal(srv.hub.isDeviceConnected('A-02'), true);

    const rotated = (await admin.post('/api/admin/carts/A-02/device-token')).json.token;
    assert.notEqual(rotated, token);
    await assert.rejects(openWs(`${srv.wsBase}/ws/device/A-02?token=${token}`), { status: 401 }, 'old token revoked');
    ws.close();
  });

  it('parses the binary frame format', () => {
    const msg = parseFrameMessage(Buffer.concat([Buffer.from('{"seq":3}\n'), Buffer.from([1, 2, 3])]));
    assert.equal(msg.header.seq, 3);
    assert.deepEqual([...msg.jpeg], [1, 2, 3]);
    assert.equal(parseFrameMessage(Buffer.from('no header')), null);
    assert.equal(parseFrameMessage(Buffer.from('{"seq":"x"}\n')), null);
  });
});
