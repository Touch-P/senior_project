import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { applyItemChange } from '../src/pipeline/persist.js';
import { adminOnlyRoutes } from '../src/routes/registry.js';
import { cartSnapshot } from '../src/services/cart.js';
import { barcodeChecksumOk, normalize, promoteDuePrices } from '../src/services/products.js';
import { ADMIN, client, openWs, STAFF, startServer } from './helpers.js';

let srv, admin, staff;
before(async () => {
  srv = await startServer();
  admin = client(srv.base);
  await admin.login(ADMIN);
  staff = client(srv.base);
  await staff.login(STAFF);
});
after(() => srv.close());

const id = (cls) => srv.db.prepare('SELECT product_id FROM products WHERE class_name = ?').pluck().get(cls);
const search = (q, extra = '') => admin.get(`/api/admin/products/search?q=${encodeURIComponent(q)}${extra}`);

describe('helpers', () => {
  test('EAN-13 / EAN-8 / UPC-A check digits', () => {
    assert.ok(barcodeChecksumOk('8850718801213'));   // Lay's original (master data)
    assert.ok(!barcodeChecksumOk('8850718801214'));
    assert.ok(barcodeChecksumOk('96385074'));        // EAN-8 example
    assert.ok(barcodeChecksumOk('036000291452'));    // UPC-A example
    assert.ok(!barcodeChecksumOk('12345'));
    assert.equal(normalize('  Lay  Big '), 'laybig');
  });
});

describe('admin product search (brief 8)', () => {
  test('all product routes are admin-only: staff gets 403 on every one', async () => {
    const routes = [...adminOnlyRoutes].filter((r) => r.includes('/api/admin/products'));
    assert.equal(routes.length, 6, routes.join(', '));
    for (const route of routes) {
      const [method, path] = route.split(' ');
      const res = await staff.call(method, path.replace(':id', String(id('lay_big_ori'))), method === 'GET' ? undefined : {});
      assert.equal(res.status, 403, route);
    }
    // the read-only table stays available to staff
    assert.equal((await staff.get('/api/products')).status, 200);
  });

  test('Thai partial names: "เลย์" finds every Lay\'s, "โนริ" finds lay_big_nori first', async () => {
    const lay = await search('เลย์');
    assert.equal(lay.status, 200);
    assert.equal(lay.json.mode, 'fts');
    assert.deepEqual(lay.json.results.map((p) => p.class_name).sort(), ['lay_big_nori', 'lay_big_ori', 'lay_big_rock_ori', 'lay_party_ori']);
    const nori = await search('โนริ');
    assert.equal(nori.json.results[0].class_name, 'lay_big_nori');
    assert.ok(nori.json.results[0].price > 0);
  });

  test('class_name, SKU, brand and short queries (LIKE fallback, no spaces needed)', async () => {
    assert.equal((await search('pringles_norm_ori')).json.results[0].class_name, 'pringles_norm_ori', 'exact class_name ranks first');
    assert.equal((await search('SN-LAY-NRB')).json.results[0].class_name, 'lay_big_nori');
    const short = await search('มา');
    assert.equal(short.json.mode, 'like');
    assert.ok(short.json.results.some((p) => p.class_name.startsWith('mama')));
    const spaced = await search('เลย์ รสโนริ');
    assert.equal(spaced.json.results[0].class_name, 'lay_big_nori');
    assert.equal((await search('xyz-not-here')).json.results.length, 0);
  });

  test('barcode: exact match, wrong check digit warning, not found', async () => {
    const hit = await search('8850718801213');
    assert.equal(hit.json.mode, 'barcode');
    assert.equal(hit.json.results[0].class_name, 'lay_big_ori');
    assert.equal(hit.json.checksum_ok, true);
    const typo = await admin.get('/api/admin/products/search?barcode=8850718801214');
    assert.equal(typo.json.checksum_ok, false);
    assert.match(typo.json.warning, /สแกนหรือพิมพ์ผิด/);
    assert.equal(typo.json.barcode_not_found, true);
  });

  test('new price closes the old row (SCD2) and the history is right', async () => {
    const pid = id('lay_big_ori');
    const before = (await admin.get(`/api/admin/products/${pid}`)).json;
    assert.equal(before.prices.length, 1);
    const res = await admin.post(`/api/admin/products/${pid}/prices`, { price: 33, promo_price: 29, via: 'search_name' });
    assert.equal(res.status, 201);
    const [cur, old] = res.json.prices;
    assert.deepEqual([cur.price, cur.promo_price, cur.is_current, cur.valid_to_ms], [33, 29, true, null]);
    assert.equal(old.is_current, false);
    assert.equal(old.valid_to_ms, cur.valid_from_ms);
    assert.equal(cur.created_by_name, 'สมชาย ใจดี');
    assert.equal(res.json.audit[0].action, 'PRICE');
    assert.equal(res.json.audit[0].via, 'search_name');
    // validation
    assert.equal((await admin.post(`/api/admin/products/${pid}/prices`, { price: 30, promo_price: 31 })).status, 400);
    assert.equal((await admin.post(`/api/admin/products/${pid}/prices`, { price: -1 })).status, 400);
  });

  test('an item already in a cart keeps the price it was added at', async () => {
    const sid = (await client(srv.base).post('/api/sessions', { cart: 'A-01' })).json.session_id;
    const pid = id('pringles_norm_ori');
    srv.db.transaction(() => applyItemChange(srv.db, { sessionId: sid, storeId: 1, productId: pid, delta: 1 }))();
    assert.equal(cartSnapshot(srv.db, sid).total, 45);
    await admin.post(`/api/admin/products/${pid}/prices`, { price: 50 });
    assert.equal(cartSnapshot(srv.db, sid).total, 45, 'snapshot taken at ADD');
    const after = (await client(srv.base).post('/api/sessions', { cart: 'A-02' })).json.session_id;
    srv.db.transaction(() => applyItemChange(srv.db, { sessionId: after, storeId: 1, productId: pid, delta: 1 }))();
    assert.equal(cartSnapshot(srv.db, after).total, 50, 'new ADDs get the new price');
  });

  test('a future price waits, then becomes current when due', async () => {
    const pid = id('doritos_mid_nacho');
    const from = Date.now() + 60_000;
    const res = await admin.post(`/api/admin/products/${pid}/prices`, { price: 22, valid_from_ms: from });
    assert.equal(res.json.price, 20, 'still the old price');
    assert.equal(res.json.prices.find((p) => p.valid_from_ms === from).is_current, false);
    assert.equal(promoteDuePrices(srv.db, from + 1), 1);
    assert.equal((await admin.get(`/api/admin/products/${pid}`)).json.price, 22);
  });

  test('binding a barcode: 409 when another product owns it; audit records the channel', async () => {
    const taken = await admin.post(`/api/admin/products/${id('kirei_refill_lavender')}/barcode`, { barcode: '8850718801213', via: 'scan_camera' });
    assert.equal(taken.status, 409);
    assert.equal(taken.json.error, 'BARCODE_TAKEN');
    assert.equal(taken.json.product.class_name, 'lay_big_ori');
    const ok = await admin.post(`/api/admin/products/${id('kirei_refill_lavender')}/barcode`, { barcode: '8850002035188', via: 'scan_camera' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.barcode, '8850002035188');
    assert.equal(ok.json.checksum_ok, true);
    const audit = srv.db.prepare("SELECT action, via, new_value FROM product_audit WHERE product_id = ? ORDER BY audit_id DESC").get(id('kirei_refill_lavender'));
    assert.deepEqual(audit, { action: 'BIND_BARCODE', via: 'scan_camera', new_value: '8850002035188' });
    // the peach refill shares that barcode in the xlsx: binding it too is refused
    assert.equal((await admin.post(`/api/admin/products/${id('kirei_refill_peach')}/barcode`, { barcode: '8850002035188' })).status, 409);
    assert.equal((await admin.post(`/api/admin/products/${id('kirei_refill_peach')}/barcode`, { barcode: '88ab' })).status, 400);
  });

  test('editing: class_name locked while the model detects it; changes are audited and broadcast', async () => {
    const watcher = await openWs(`${srv.wsBase}/ws/admin`, { cookie: admin.cookie });
    const pid = id('lay_big_ori');
    const locked = await admin.patch(`/api/admin/products/${pid}`, { class_name: 'lay_renamed' });
    assert.equal(locked.status, 409);
    assert.equal(locked.json.error, 'CLASS_NAME_LOCKED');
    const res = await admin.patch(`/api/admin/products/${pid}`, { name_th: 'เลย์ ออริจินัล ห่อใหญ่', flavor: 'original', via: 'table' });
    assert.equal(res.status, 200);
    assert.equal(res.json.name_th, 'เลย์ ออริจินัล ห่อใหญ่');
    const msg = await watcher.next('products_changed');
    assert.equal(msg.product_id, pid);
    // the FTS index follows the rename
    assert.equal((await search('ออริจินัล')).json.results[0].class_name, 'lay_big_ori');
    assert.equal(res.json.audit.filter((a) => a.action === 'UPDATE').length, 1, 'unchanged fields are not audited');
    watcher.ws.close();
  });

  test('a new product (barcode not found) starts outside the model; deactivating is audited', async () => {
    const res = await admin.post('/api/admin/products', {
      class_name: 'tao_kae_noi_big', name_th: 'เถ้าแก่น้อย สาหร่ายทอด ห่อใหญ่', brand: 'Tao Kae Noi', sub_category: 'chips',
      barcode: '8857101400017', price: 39, via: 'scan_camera',
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.in_model, false);
    assert.equal(res.json.price, 39);
    assert.equal(res.json.audit[0].action, 'CREATE');
    assert.equal((await search('8857101400017')).json.results[0].class_name, 'tao_kae_noi_big');
    assert.equal((await admin.post('/api/admin/products', { class_name: 'tao_kae_noi_big', name_th: 'x', price: 1 })).status, 409);
    const off = await admin.patch(`/api/admin/products/${res.json.product_id}`, { is_active: false });
    assert.equal(off.json.is_active, false);
    assert.equal(off.json.audit[0].action, 'DEACTIVATE');
    // a renamed class_name is fine while the model does not know the product
    assert.equal((await admin.patch(`/api/admin/products/${res.json.product_id}`, { class_name: 'taokaenoi_big_ori' })).status, 200);
  });
});
