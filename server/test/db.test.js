import './setup.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { config } from '../src/config.js';
import { importProductMaster, parseCsv, readProductMaster, syncModelCoverage } from '../src/db/catalog.js';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { CLASSES, seed } from '../src/db/seed.js';

async function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  await seed(db, { probeInference: false });
  return db;
}

describe('migrations', () => {
  it('creates every table and view from scratch', () => {
    const db = openDb(':memory:');
    const { applied } = migrate(db);
    assert.deepEqual(applied, readdirSync(config.migrationsDir).filter((f) => f.endsWith('.sql')).sort());
    assert.ok(applied.length >= 5);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").pluck().all();
    for (const t of ['stores', 'devices', 'carts', 'products', 'product_prices', 'model_versions', 'shopping_sessions',
      'cart_events', 'cart_item_history', 'frames', 'detections', 'user_feedback', 'alerts', 'admin_users',
      'cart_item_presence', 'change_reasons', 'product_audit', 'products_fts', 'job_runs', 'admin_sessions',
      'v_product_abandon', 'v_cooccurrence', 'v_frame_latency', 'v_change_reason_summary']) {
      assert.ok(names.includes(t), `missing ${t}`);
    }
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.deepEqual(migrate(db).applied, [], 'second run applies nothing');
  });
});

describe('seed', () => {
  it('loads 20 products, all 20 detectable by the active model', async () => {
    const db = await freshDb();
    assert.equal(db.prepare('SELECT COUNT(*) FROM products').pluck().get(), 20);
    assert.equal(db.prepare('SELECT COUNT(*) FROM products WHERE in_model = 1').pluck().get(), 20);
    assert.deepEqual(db.prepare('SELECT class_name FROM products WHERE in_model = 1 ORDER BY class_name').pluck().all(),
      [...CLASSES].sort());
    assert.equal(db.prepare('SELECT name FROM model_versions WHERE is_active = 1').pluck().get(), 'yolo11s-20261104');
    assert.equal(db.prepare('SELECT COUNT(*) FROM carts').pluck().get(), 17);
    assert.equal(db.prepare("SELECT roi_polygon FROM carts WHERE label = 'A-07'").pluck().get(), '[[0.2,0.14],[0.8,0.14],[0.96,0.99],[0.04,0.99]]');
    assert.equal(db.prepare("SELECT COUNT(*) FROM admin_users WHERE role = 'staff'").pluck().get(), 0, 'no demo staff outside development');
  });

  it('is idempotent', async () => {
    const db = await freshDb();
    const snapshot = () => db.prepare('SELECT (SELECT COUNT(*) FROM products), (SELECT COUNT(*) FROM product_prices), (SELECT COUNT(*) FROM carts), (SELECT COUNT(*) FROM devices), (SELECT COUNT(*) FROM admin_users)').raw().get();
    const before = snapshot();
    await seed(db, { probeInference: false });
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(db.prepare('SELECT status FROM job_runs').pluck().all(), ['ok', 'ok']);
  });

  it('keeps the admin-chosen model active on re-seed', async () => {
    const db = await freshDb();
    db.prepare('UPDATE model_versions SET is_active = 0').run();
    db.prepare("UPDATE model_versions SET is_active = 1 WHERE name = 'yolo26s-20261104'").run();
    await seed(db, { probeInference: false });
    assert.equal(db.prepare('SELECT name FROM model_versions WHERE is_active = 1').pluck().get(), 'yolo26s-20261104');
  });
});

describe('product master', () => {
  it('parses quoted CSV fields', () => {
    assert.deepEqual(parseCsv('a,b\r\n"x, ""y""",2\n'), [{ a: 'x, "y"', b: '2' }]);
  });

  it('opens a new SCD2 price row when the master price changes', async () => {
    const db = await freshDb();
    const master = readProductMaster().map((p) => (p.class_name === 'lay_big_ori' ? { ...p, price: 33 } : p));
    const stats = importProductMaster(db, master, Date.now() + 1000);
    assert.equal(stats.prices, 1);
    const rows = db.prepare(`SELECT price, is_current, valid_to_ms FROM product_prices pp JOIN products p USING (product_id)
                             WHERE class_name = 'lay_big_ori' ORDER BY price_id`).all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].is_current, 0);
    assert.ok(rows[0].valid_to_ms > 0);
    assert.deepEqual([rows[1].price, rows[1].is_current, rows[1].valid_to_ms], [33, 1, null]);
  });

  it('never overwrites prices or attributes edited by an admin', async () => {
    const db = await freshDb();
    const id = db.prepare("SELECT product_id FROM products WHERE class_name = 'doritos_mid_nacho'").pluck().get();
    const admin = db.prepare("SELECT user_id FROM admin_users WHERE role = 'admin'").pluck().get();
    db.prepare('UPDATE product_prices SET is_current = 0, valid_to_ms = ? WHERE product_id = ?').run(Date.now(), id);
    db.prepare('INSERT INTO product_prices (product_id, price, valid_from_ms, created_by) VALUES (?, 25, ?, ?)').run(id, Date.now() + 1, admin);
    db.prepare("UPDATE products SET name_th = 'แก้โดย admin' WHERE product_id = ?").run(id);
    db.prepare("INSERT INTO product_audit (product_id, user_id, action, field, via) VALUES (?, ?, 'UPDATE', 'name_th', 'table')").run(id, admin);
    await seed(db, { probeInference: false });
    assert.equal(db.prepare('SELECT price FROM product_prices WHERE product_id = ? AND is_current = 1').pluck().get(id), 25);
    assert.equal(db.prepare('SELECT name_th FROM products WHERE product_id = ?').pluck().get(id), 'แก้โดย admin');
  });

  it('rejects a duplicate class_name in the master file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-'));
    const src = readFileSync(join(config.seedDir, 'products_master.csv'), 'utf8').trimEnd().split('\n');
    writeFileSync(join(dir, 'm.csv'), [...src, src[1]].join('\n'));
    assert.throws(() => readProductMaster(join(dir, 'm.csv')), /duplicate class_name/);
  });
});

describe('model coverage', () => {
  it('a 20-class model marks all products detectable without code changes', async () => {
    const db = await freshDb();
    const all = db.prepare('SELECT class_name FROM products').pluck().all();
    const res = syncModelCoverage(db, [...all, 'unknown_new_item']);
    assert.equal(res.detectable, 20);
    assert.deepEqual(res.missingInProducts, ['unknown_new_item']);
    assert.equal(db.prepare('SELECT COUNT(*) FROM products WHERE in_model = 1').pluck().get(), 20);
  });
});

describe('constraints and search', () => {
  it('enforces one active session per cart, unique barcodes and promo < price', async () => {
    const db = await freshDb();
    const cart = db.prepare("SELECT cart_id FROM carts WHERE label = 'A-07'").pluck().get();
    const add = db.prepare("INSERT INTO shopping_sessions (session_id, cart_id, started_at_ms) VALUES (?, ?, ?)");
    add.run('s1', cart, 1);
    assert.throws(() => add.run('s2', cart, 2), /UNIQUE/);
    assert.throws(() => db.prepare("UPDATE products SET barcode = '8850718801213' WHERE class_name = 'lay_big_nori'").run(), /UNIQUE/);
    assert.throws(() => db.prepare('INSERT INTO product_prices (product_id, price, promo_price, valid_from_ms) VALUES (1, 10, 12, 1)').run(), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO alerts (alert_type, severity, message, created_at_ms) VALUES ('NOPE', 'info', 'x', 1)").run(), /FOREIGN KEY/);
  });

  it('finds Thai partial names with the trigram index and stays in sync on update', async () => {
    const db = await freshDb();
    const match = (q) => db.prepare('SELECT class_name FROM products_fts WHERE products_fts MATCH ? ORDER BY class_name').pluck().all(`"${q}"`);
    assert.deepEqual(match('โนริ'), ['lay_big_nori']);
    assert.equal(match('เลย์').length, 4);
    db.prepare("UPDATE products SET name_th = 'มันฝรั่งทดสอบ' WHERE class_name = 'doritos_mid_nacho'").run();
    assert.deepEqual(match('ฝรั่งทด'), ['doritos_mid_nacho']);
    assert.deepEqual(match('โดริโทส'), []);
  });

  it('computes co-occurrence lift for checked-out baskets', async () => {
    const db = await freshDb();
    const id = (c) => db.prepare('SELECT product_id FROM products WHERE class_name = ?').pluck().get(c);
    const cart = db.prepare("SELECT cart_id FROM carts WHERE label = 'A-01'").pluck().get();
    const baskets = [['lay_big_ori', 'pringles_norm_ori'], ['lay_big_ori', 'pringles_norm_ori'], ['rosdee_mid_pork'], ['lay_big_ori']];
    baskets.forEach((items, i) => {
      db.prepare("INSERT INTO shopping_sessions (session_id, cart_id, status, started_at_ms) VALUES (?, ?, 'checked_out', ?)").run(`b${i}`, cart, i);
      for (const c of items) db.prepare("INSERT INTO cart_events (session_id, event_type, product_id, qty_delta, occurred_at_ms) VALUES (?, 'ADD', ?, 1, ?)").run(`b${i}`, id(c), i);
    });
    const row = db.prepare('SELECT sessions_together, support, lift FROM v_cooccurrence WHERE product_a = ? AND product_b = ?')
      .get(Math.min(id('lay_big_ori'), id('pringles_norm_ori')), Math.max(id('lay_big_ori'), id('pringles_norm_ori')));
    // support = 2/4; lift = 0.5 / (3/4 * 2/4) = 1.333
    assert.deepEqual(row, { sessions_together: 2, support: 0.5, lift: 1.333 });
  });
});

describe('004 alignment with instruction 2.7', () => {
  const cols = (db, t) => db.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(t);

  it('adds the missing columns and renames cart_events columns', async () => {
    const db = await freshDb();
    assert.ok(cols(db, 'stores').includes('timezone'));
    for (const c of ['store_id', 'camera_desc', 'app_version']) assert.ok(cols(db, 'devices').includes(c), c);
    assert.ok(cols(db, 'products').includes('weight_g'));
    assert.ok(cols(db, 'product_prices').includes('store_id'));
    assert.ok(cols(db, 'model_versions').includes('imgsz'));
    for (const c of ['rtt_ms', 'num_detections']) assert.ok(cols(db, 'frames').includes(c), c);
    assert.ok(cols(db, 'user_feedback').includes('reported_by'));
    assert.ok(cols(db, 'alerts').includes('resolved_by'));
    const ev = cols(db, 'cart_events');
    assert.ok(ev.includes('confidence_avg') && ev.includes('occurred_at_ms'));
    assert.ok(!ev.includes('confidence') && !ev.includes('t_ms'));
    assert.ok(cols(db, 'v_frame_latency').includes('rtt_ms'));
    assert.equal(db.prepare("SELECT COUNT(*) FROM devices WHERE store_id IS NULL").pluck().get(), 0);
    assert.equal(db.prepare("SELECT weight_g FROM products WHERE class_name = 'lay_party_ori'").pluck().get(), 105);
  });

  it('allows one current price per product and store, NULL store meaning all stores', async () => {
    const db = await freshDb();
    const store = db.prepare('SELECT store_id FROM stores').pluck().get();
    const add = db.prepare('INSERT INTO product_prices (product_id, store_id, price, valid_from_ms) VALUES (1, ?, 30, 1)');
    add.run(store);                                    // store-specific price next to the all-store price
    assert.throws(() => add.run(store), /UNIQUE/);     // second current price for the same store
    assert.throws(() => add.run(null), /UNIQUE/);      // second all-store current price
  });

  it('counts only automatic events in v_product_abandon', async () => {
    const db = await freshDb();
    const cart = db.prepare("SELECT cart_id FROM carts WHERE label = 'A-02'").pluck().get();
    db.prepare("INSERT INTO shopping_sessions (session_id, cart_id, started_at_ms) VALUES ('ab', ?, 1)").run(cart);
    const pid = db.prepare("SELECT product_id FROM products WHERE class_name = 'lay_big_ori'").pluck().get();
    const ev = db.prepare("INSERT INTO cart_events (session_id, event_type, product_id, qty_delta, source, occurred_at_ms) VALUES ('ab', ?, ?, ?, ?, 1)");
    ev.run('ADD', pid, 2, 'auto');
    ev.run('REMOVE', pid, -1, 'auto');
    ev.run('REMOVE', pid, -1, 'staff');
    const row = db.prepare('SELECT added, removed, abandon_rate FROM v_product_abandon WHERE product_id = ?').get(pid);
    assert.deepEqual(row, { added: 2, removed: 1, abandon_rate: 0.5 });
  });
});
