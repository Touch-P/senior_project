import './setup.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { config } from '../src/config.js';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { computeDay, runAnalytics } from '../src/jobs/analytics.js';
import { exportFeedback, exportLatency } from '../src/jobs/exports.js';
import { backup, closeIdleSessions, restore, retention } from '../src/jobs/maintenance.js';
import { dayBounds, localDay } from '../src/jobs/time.js';
import { applyItemChange, writeFrame } from '../src/pipeline/persist.js';
import { closeSession, startSession } from '../src/services/sessions.js';

// scratch space inside the repo (gitignored), removed at the end
const TMP = join(config.ROOT, 'data', 'frames', '_test', `jobs-${process.pid}`);
const DBTMP = join(config.ROOT, 'db', `_test-${process.pid}`);
mkdirSync(TMP, { recursive: true });
mkdirSync(DBTMP, { recursive: true });
after(() => {
  for (const d of [TMP, DBTMP]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* a handle may still be closing */ } }
});

const hub = () => ({ events: new EventEmitter(), toAdmins() {}, toDisplay() {}, toDevice() {}, closeDisplays() {} });
async function freshDb(path = ':memory:') {
  const db = openDb(path);
  migrate(db);
  await seed(db, { probeInference: false });
  return db;
}
const pid = (db, cls) => db.prepare('SELECT product_id FROM products WHERE class_name = ?').pluck().get(cls);
function basket(db, h, cart, classes, { at = Date.now(), checkout = true } = {}) {
  const { session_id: sid } = startSession(db, h, { cart });
  db.prepare('UPDATE shopping_sessions SET started_at_ms = ? WHERE session_id = ?').run(at, sid);
  for (const c of classes) db.transaction(() => applyItemChange(db, { sessionId: sid, storeId: 1, productId: pid(db, c), delta: 1, at: at + 1000 }))();
  if (checkout) closeSession(db, h, sid, {});
  return sid;
}
const jobRuns = (db, job) => db.prepare('SELECT status, rows_affected FROM job_runs WHERE job = ? ORDER BY run_id').all(job);

describe('local days (Asia/Bangkok)', () => {
  test('day bounds and day of an instant', () => {
    const [a, b] = dayBounds('2026-11-03', 'Asia/Bangkok');
    assert.equal(a, Date.UTC(2026, 10, 2, 17));
    assert.equal(b - a, 86_400_000);
    assert.equal(localDay(Date.UTC(2026, 10, 2, 17, 0, 1), 'Asia/Bangkok'), '2026-11-03');
    assert.equal(localDay(Date.UTC(2026, 10, 2, 16, 59), 'Asia/Bangkok'), '2026-11-02');
  });
});

describe('analytics job', () => {
  test('daily products, co-occurrence lift and reasons; re-running gives the same rows', async () => {
    const db = await freshDb();
    const h = hub();
    basket(db, h, 'A-01', ['lay_big_ori', 'pringles_norm_ori']);
    basket(db, h, 'A-02', ['lay_big_ori', 'pringles_norm_ori', 'bengbeng_pack12']);
    basket(db, h, 'A-03', ['bengbeng_pack12']);
    basket(db, h, 'A-04', ['lay_big_ori'], { checkout: false }); // still shopping: not a basket
    const day = localDay(Date.now(), 'Asia/Bangkok');
    const r1 = computeDay(db, day);
    const rows1 = db.prepare('SELECT * FROM daily_cooccurrence ORDER BY product_a, product_b').all();
    const r2 = (await runAnalytics(db, { day }));
    assert.deepEqual({ products: r2.products, pairs: r2.pairs }, { products: r1.products, pairs: r1.pairs });
    assert.deepEqual(db.prepare('SELECT * FROM daily_cooccurrence ORDER BY product_a, product_b').all().map(({ computed_at_ms, ...x }) => x),
      rows1.map(({ computed_at_ms, ...x }) => x), 'idempotent');
    // lay+pringles together in 2 of 3 baskets; lay in 2/3, pringles in 2/3 -> lift = (2/3)/((2/3)(2/3)) = 1.5
    const lp = db.prepare('SELECT * FROM daily_cooccurrence WHERE product_a = ? AND product_b = ?')
      .get(Math.min(pid(db, 'lay_big_ori'), pid(db, 'pringles_norm_ori')), Math.max(pid(db, 'lay_big_ori'), pid(db, 'pringles_norm_ori')));
    assert.deepEqual([lp.sessions_together, lp.baskets, lp.support, lp.lift], [2, 3, 0.6667, 1.5]);
    const lay = db.prepare('SELECT * FROM daily_product_stats WHERE day = ? AND product_id = ?').get(day, pid(db, 'lay_big_ori'));
    assert.equal(lay.purchased, 2, 'only checked-out baskets count as purchased');
    assert.equal(lay.added, 3);
    assert.equal(lay.revenue, 62);
    assert.deepEqual(jobRuns(db, 'analytics').map((x) => x.status), ['ok']);
    db.close();
  });
});

describe('session timeout job', () => {
  test('idle sessions close as timeout (items) or abandoned (empty), with presence and reasons finalized', async () => {
    const db = await freshDb();
    const h = hub();
    const old = Date.now() - 2 * 3_600_000;
    const withItems = basket(db, h, 'A-05', ['lay_big_ori'], { at: old, checkout: false });
    const empty = basket(db, h, 'A-06', [], { at: old, checkout: false });
    const fresh = basket(db, h, 'A-07', ['lay_big_nori'], { checkout: false });
    // a pending reason and a hidden unit left behind (as if the server had restarted mid-session)
    db.prepare(`INSERT INTO change_reasons (session_id, reason_code, status, from_product_id, rule_version, decided_at_ms) VALUES (?, 'ABANDON', 'pending', ?, 'v1', ?)`).run(withItems, pid(db, 'lay_big_ori'), old);
    db.prepare(`INSERT INTO cart_item_presence (session_id, product_id, unit_no, state, change_cause, valid_from_ms) VALUES (?, ?, 1, 'OCCLUDED', 'NOT_SEEN', ?)`).run(withItems, pid(db, 'lay_big_ori'), old);
    const r = await closeIdleSessions(db, h, { idleMs: 30 * 60_000 });
    assert.equal(r.rows, 2);
    const st = (id) => db.prepare('SELECT status FROM shopping_sessions WHERE session_id = ?').pluck().get(id);
    assert.deepEqual([st(withItems), st(empty), st(fresh)], ['timeout', 'abandoned', 'active']);
    assert.equal(db.prepare("SELECT status FROM change_reasons WHERE session_id = ?").pluck().get(withItems), 'final');
    assert.equal(db.prepare("SELECT COUNT(*) FROM cart_item_presence WHERE session_id = ? AND is_current = 1 AND state != 'REMOVED'").pluck().get(withItems), 0);
    assert.equal((await closeIdleSessions(db, h, { idleMs: 30 * 60_000 })).rows, 0, 'nothing left the second time');
    db.close();
  });
});

describe('retention job', () => {
  test('deletes old frames, detections and files; keeps frames of open reports; second run is a no-op', async () => {
    const db = await freshDb();
    const h = hub();
    const sid = basket(db, h, 'A-08', ['lay_big_ori'], { checkout: false });
    const cartId = db.prepare("SELECT cart_id FROM carts WHERE label = 'A-08'").pluck().get();
    const old = Date.now() - 40 * 86_400_000;
    const mk = (t, withFile) => {
      const id = db.transaction(() => writeFrame(db, { session_id: sid, cart_id: cartId, model_id: null, seq: t % 1000, width: 640, height: 480, jpeg_bytes: 4,
        t_capture_device_ms: null, t_received_ms: t, t_infer_start_ms: t, t_infer_end_ms: t, infer_ms: 1, t_tracker_ms: t, t_db_ms: t, t_pushed_ms: t,
        dropped: 0, error: null, image_path: null, num_detections: 1 }, [{ product_id: null, class_name: 'lay_big_ori', conf: 0.9, box: [0.1, 0.1, 0.2, 0.2], in_roi: true, accepted: true }]))();
      if (withFile) {
        const rel = `data/frames/_test/jobs-${process.pid}/r/${id}.jpg`;
        mkdirSync(join(TMP, 'r'), { recursive: true });
        writeFileSync(join(config.ROOT, rel), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        db.prepare('UPDATE frames SET image_path = ? WHERE frame_id = ?').run(rel, id);
      }
      return id;
    };
    const gone = mk(old, true), kept = mk(old + 1, true), recent = mk(Date.now(), false);
    db.prepare(`INSERT INTO cart_events (session_id, event_type, product_id, qty_delta, frame_id, occurred_at_ms) VALUES (?, 'ADD', ?, 1, ?, ?)`).run(sid, pid(db, 'lay_big_ori'), gone, old);
    db.prepare(`INSERT INTO user_feedback (session_id, frame_id, issue_type, created_at_ms) VALUES (?, ?, 'missing', ?)`).run(sid, kept, old);
    const r = await retention(db, { days: 30, framesDir: TMP, root: config.ROOT, vacuum: false });
    assert.equal(r.rows, 1);
    assert.equal(r.files, 1);
    const ids = db.prepare('SELECT frame_id FROM frames ORDER BY frame_id').pluck().all();
    assert.deepEqual(ids, [kept, recent]);
    assert.equal(db.prepare('SELECT COUNT(*) FROM detections WHERE frame_id = ?').pluck().get(gone), 0, 'detections cascade');
    assert.equal(db.prepare("SELECT frame_id FROM cart_events WHERE event_type = 'ADD' AND occurred_at_ms = ?").pluck().get(old), null);
    assert.ok(!existsSync(join(TMP, 'r', `${gone}.jpg`)));
    assert.ok(existsSync(join(TMP, 'r', `${kept}.jpg`)));
    assert.equal((await retention(db, { days: 30, framesDir: TMP, root: config.ROOT })).rows, 0, 'second run (with VACUUM) is a no-op');
    db.close();
  });
});

describe('backup and restore', () => {
  test('online backup is integrity-checked and pruned to `keep`; restore brings data back and keeps the old file', async () => {
    const dbPath = join(DBTMP, 'live.db');
    const dir = join(DBTMP, 'backups');
    const db = await freshDb(dbPath);
    const files = [];
    try {
      basket(db, hub(), 'A-01', ['lay_big_ori']);
      for (let i = 0; i < 3; i++) files.push((await backup(db, { dir, keep: 2, now: new Date(Date.UTC(2026, 10, 1 + i, 19, 30)) })).file);
      assert.deepEqual(readdirSync(dir).sort(), ['smartcart-20261102-193000.db', 'smartcart-20261103-193000.db'], 'single files, newest 2 kept');
      // damage the live data, then restore the newest backup
      db.prepare('DELETE FROM cart_item_history').run();
      db.prepare("UPDATE shopping_sessions SET status = 'abandoned'").run();
    } finally {
      db.close();
    }
    const r = restore({ backupFile: files[2], dbPath, now: new Date(Date.UTC(2026, 10, 4)) });
    assert.equal(r.sessions, 1);
    assert.ok(existsSync(r.aside), 'previous database kept');
    const back = new Database(dbPath, { readonly: true });
    assert.equal(back.prepare("SELECT status FROM shopping_sessions").pluck().get(), 'checked_out');
    assert.equal(back.prepare('SELECT COUNT(*) FROM cart_item_history').pluck().get(), 1);
    back.close();
    const aside = new Database(r.aside, { readonly: true });
    assert.equal(aside.prepare('SELECT COUNT(*) FROM cart_item_history').pluck().get(), 0, 'the damaged state is what was set aside');
    aside.close();
    assert.throws(() => restore({ backupFile: join(dir, 'nope.db'), dbPath }), /not found/);
  });
});

describe('exports', () => {
  test('retrain export: image + YOLO labels + manifest + data.yaml, reports marked exported, re-run exports nothing new', async () => {
    const db = await freshDb();
    const sid = basket(db, hub(), 'A-09', ['lay_big_ori'], { checkout: false });
    const cartId = db.prepare("SELECT cart_id FROM carts WHERE label = 'A-09'").pluck().get();
    const t = Date.now();
    const fid = db.transaction(() => writeFrame(db, { session_id: sid, cart_id: cartId, model_id: null, seq: 7, width: 640, height: 480, jpeg_bytes: 4,
      t_capture_device_ms: null, t_received_ms: t, t_infer_start_ms: t, t_infer_end_ms: t + 10, infer_ms: 9, t_tracker_ms: t + 11, t_db_ms: t + 12, t_pushed_ms: t + 13,
      dropped: 0, error: null, image_path: null, num_detections: 2 }, [
      { product_id: pid(db, 'lay_big_ori'), class_name: 'lay_big_ori', conf: 0.9, box: [0.2, 0.2, 0.4, 0.6], in_roi: true, accepted: true },
      { product_id: null, class_name: 'not_in_model', conf: 0.8, box: [0.5, 0.5, 0.6, 0.6], in_roi: true, accepted: false },
    ]))();
    const rel = `data/frames/_test/jobs-${process.pid}/x/7.jpg`;
    mkdirSync(join(TMP, 'x'), { recursive: true });
    writeFileSync(join(config.ROOT, rel), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    db.prepare('UPDATE frames SET image_path = ? WHERE frame_id = ?').run(rel, fid);
    db.prepare(`INSERT INTO user_feedback (session_id, frame_id, issue_type, product_id, created_at_ms) VALUES (?, ?, 'wrong_class', ?, ?)`).run(sid, fid, pid(db, 'lay_big_ori'), t);
    const out = join(TMP, 'exports');
    const r = await exportFeedback(db, { root: config.ROOT, outDir: out });
    assert.equal(r.rows, 1);
    const label = readFileSync(join(r.dir, 'labels', `A-09_${sid.slice(0, 8)}_7.txt`), 'utf8').trim().split('\n');
    const idx = JSON.parse(db.prepare('SELECT class_names FROM model_versions WHERE is_active = 1').pluck().get()).indexOf('lay_big_ori');
    assert.deepEqual(label, [`${idx} 0.300000 0.400000 0.200000 0.400000`], 'unknown classes skipped, cx cy w h');
    assert.ok(existsSync(join(r.dir, 'images', `A-09_${sid.slice(0, 8)}_7.jpg`)));
    assert.match(readFileSync(join(r.dir, 'manifest.csv'), 'utf8'), /wrong_class,lay_big_ori/);
    assert.match(readFileSync(join(r.dir, 'data.yaml'), 'utf8'), /nc: 11/);
    assert.equal(db.prepare('SELECT status FROM user_feedback').pluck().get(), 'exported');
    assert.equal((await exportFeedback(db, { root: config.ROOT, outDir: out })).rows, 0);
    assert.equal((await exportFeedback(db, { root: config.ROOT, outDir: out, all: true })).rows, 1, '--all exports again');

    const lat = await exportLatency(db, { outDir: out, sessionId: sid });
    const lines = readFileSync(lat.file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^frame_id,session_id,cart,seq,t_received_ms,queue_ms,infer_call_ms/);
    assert.match(lines[1], new RegExp(`^${fid},${sid},A-09,7,`));
    db.close();
  });
});
