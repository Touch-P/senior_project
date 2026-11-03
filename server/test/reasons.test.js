import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { config } from '../src/config.js';
import { createMockInference } from '../src/pipeline/inferClient.js';
import { createReasonEngine, switchRule } from '../src/pipeline/reasons.js';
import { checkExpect, replayDb, replayScenario } from '../src/pipeline/replay.js';
import { expandScenario, loadScenarios, ScenarioSchema } from '../src/pipeline/scenarios.js';
import { ADMIN, client, openWs, startServer } from './helpers.js';

const scenarios = loadScenarios(config.scenariosDir);
const brief77 = [...scenarios.values()].filter((s) => /^r\d\d-/.test(s.name));

describe('brief 7.7: the 12 situations (frame scenarios through tracker + presence + reasons + SQLite)', () => {
  test('all 12 scenario files exist', () => assert.equal(brief77.length, 12));
  for (const sc of brief77) {
    test(`${sc.name}: ${sc.description}`, async () => {
      const r = await replayScenario(sc);
      try {
        assert.deepEqual(checkExpect(sc, r), []);
        // SCD2: exactly one current presence row per unit, never more
        const dup = r.db.prepare(`SELECT product_id, unit_no, COUNT(*) n FROM cart_item_presence WHERE session_id = ? AND is_current = 1
                                  GROUP BY product_id, unit_no HAVING n > 1`).all(r.sessionId);
        assert.deepEqual(dup, []);
      } finally {
        r.db.close();
      }
    });
  }

  test('test 7: the hidden item keeps its price; reasons stay empty', async () => {
    const sc = scenarios.get('r07-occluded');
    const r = await replayScenario(sc);
    const total = r.db.prepare('SELECT SUM(qty * unit_price) FROM cart_item_history WHERE session_id = ? AND is_current = 1').pluck().get(r.sessionId);
    const lay = r.db.prepare("SELECT COALESCE(promo_price, price) FROM product_prices p JOIN products USING (product_id) WHERE class_name = 'lay_big_ori' AND is_current = 1").pluck().get();
    const bb = r.db.prepare("SELECT COALESCE(promo_price, price) FROM product_prices p JOIN products USING (product_id) WHERE class_name = 'bengbeng_pack12' AND is_current = 1").pluck().get();
    assert.equal(total, lay + bb);
    assert.equal(r.reasons.length, 0);
    r.db.close();
  });

  test('admins get change_reason messages with Thai label, from/to, dwell and gap', async () => {
    const r = await replayScenario(scenarios.get('r01-brand-switch'));
    const msgs = r.messages.filter((m) => m.type === 'change_reason');
    const final = msgs.findLast((m) => m.status === 'final');
    assert.equal(final.reason_code, 'BRAND_SWITCH');
    assert.equal(final.label_th, 'เปลี่ยนแบรนด์');
    assert.equal(final.tone, 'primary');
    assert.equal(final.from.class_name, 'lay_big_ori');
    assert.equal(final.to.class_name, 'pringles_norm_ori');
    assert.ok(final.dwell_ms > 25_000 && final.gap_ms > 9_000);
    assert.equal(final.price_delta, 45 - 31);
    assert.ok(r.messages.some((m) => m.type === 'cart_event' && m.event_type === 'REMOVE'));
    r.db.close();
  });
});

describe('reason engine rules', () => {
  const P = {
    1: { class_name: 'lay_big_ori', brand: "Lay's", product_line: "Lay's", flavor: 'original', variant: 'big', sub_category: 'chips' },
    2: { class_name: 'lay_big_nori', brand: "Lay's", product_line: "Lay's", flavor: 'nori', variant: 'big', sub_category: 'chips' },
    3: { class_name: 'pringles_norm_ori', brand: 'Pringles', product_line: 'Pringles', flavor: 'original', variant: 'normal', sub_category: 'chips' },
    4: { class_name: 'koalas_march_chocolate', brand: 'Lotte', product_line: "Koala's March", flavor: 'chocolate', variant: 'standard', sub_category: 'sweet_snack' },
    5: { class_name: 'lay_party_ori', brand: "Lay's", product_line: "Lay's", flavor: 'original', variant: 'party', sub_category: 'chips' },
  };
  const engine = () => createReasonEngine({ windowMs: 60_000, attrs: (id) => P[id] });
  const rm = (productId, at, qtyAfter = 0) => ({ key: `r${at}`, productId, at, qtyBefore: qtyAfter + 1, qtyAfter, unitPrice: 31, dwellMs: 5000 });
  const add = (productId, at, qtyBefore = 0) => ({ key: `a${at}`, productId, at, qtyBefore, qtyAfter: qtyBefore + 1, unitPrice: 45 });

  test('switchRule priority: brand (same sub_category) > flavor > variant; other categories do not pair', () => {
    assert.equal(switchRule(P[1], P[3]).code, 'BRAND_SWITCH');
    assert.equal(switchRule(P[1], P[2]).code, 'FLAVOR_SWITCH');
    assert.equal(switchRule(P[1], P[5]).code, 'VARIANT_SWITCH');
    assert.equal(switchRule(P[1], P[4]), null);
  });

  test('an ADD before the REMOVE pairs too (new item put in first)', () => {
    const e = engine();
    e.onAdd(add(3, 1000));
    const [r] = e.onRemove(rm(1, 5000));
    assert.equal(r.status, 'final');
    assert.equal(r.code, 'BRAND_SWITCH');
    assert.equal(r.gapMs, 4000);
  });

  test('a weaker pair stays pending and is replaced by a better one; the replaced ADD is free again', () => {
    const e = engine();
    e.onRemove(rm(1, 0));
    const [tent] = e.onAdd(add(2, 5000));
    assert.equal(tent.status, 'pending');
    assert.equal(tent.code, 'FLAVOR_SWITCH');
    const [fin] = e.onAdd(add(3, 15_000));
    assert.equal(fin.status, 'final');
    assert.equal(fin.code, 'BRAND_SWITCH');
    assert.equal(fin.toProductId, 3);
    assert.deepEqual(e.tick(100_000), []);
  });

  test('same product put back after the REMOVE = net zero (voided); ADD outside the window does not pair', () => {
    const e = engine();
    e.onRemove(rm(1, 0));
    e.onAdd(add(1, 3000));
    const [r] = e.tick(70_000);
    assert.equal(r.status, 'voided');
    const e2 = engine();
    e2.onRemove(rm(1, 0));
    e2.onAdd(add(3, 61_000));
    assert.equal(e2.tick(70_000)[0].code, 'ABANDON');
  });

  test('coming back for one more after 30 s is a QTY_CHANGE increase; two at once is not', () => {
    const e = engine();
    e.onAdd(add(1, 0));
    assert.deepEqual(e.onAdd(add(1, 5_000, 1)), []);
    const [inc] = e.onAdd(add(1, 50_000, 2));
    assert.equal(inc.code, 'QTY_CHANGE');
    assert.equal(inc.qtyBefore, 2);
    assert.equal(e.tick(120_000)[0].status, 'final');
  });

  test('checkout finalizes pending reasons; a corrected REMOVE is voided', () => {
    const e = engine();
    e.onRemove(rm(1, 0, 1));
    const [r] = e.finalizeAll(10_000);
    assert.equal(r.code, 'QTY_CHANGE');
    assert.equal(r.status, 'final');
    const e2 = engine();
    e2.onRemove(rm(1, 0));
    assert.equal(e2.voidRemove('r0', 2000)[0].status, 'voided');
  });
});

describe('model flip correction (7.3)', () => {
  test('a stable, more confident new class for 2W frames corrects the item without REMOVE/ADD or reasons', async () => {
    const box = [0.35, 0.4, 0.55, 0.65];
    const sc = ScenarioSchema.parse({
      name: 'flip-correct', fps: 4, loop: false, timeline: [
        { frames: 4, objects: [{ id: 'x', class_name: 'lay_big_ori', conf: 0.72, box, from: [0.35, 1.15, 0.55, 1.4] }] },
        { frames: 20, objects: [{ id: 'x', class_name: 'lay_big_ori', conf: 0.72, box }] },
        { frames: 24, objects: [{ id: 'x', class_name: 'lay_party_ori', conf: 0.95, box }] },
      ],
      expect: { cart: 'A-03' },
    });
    const r = await replayScenario({ ...sc, frames: expandScenario(sc) });
    assert.deepEqual(r.items, { lay_party_ori: 1 });
    assert.deepEqual(r.events, { ADD: 1, CORRECTION: 2 });
    assert.deepEqual(r.alerts, ['MODEL_FLIP']);
    assert.equal(r.reasons.length, 0);
    r.db.close();
  });
});

describe('RQ4 tracker modes share one interface', () => {
  test('every mode runs every 7.7 scenario; window mode passes all of them', async () => {
    const db = await replayDb();
    db.close();
    for (const mode of ['frame', 'window', 'bytetrack']) {
      for (const sc of brief77) {
        const r = await replayScenario(sc, { mode });
        if (mode === 'window') assert.deepEqual(checkExpect(sc, r), [], `${mode} ${sc.name}`);
        r.db.close();
      }
    }
  });
});

describe('live pipeline: admin sees the reason within 1 s of finalize (Phase 6 DoD)', () => {
  let srv, admin, token;
  before(async () => {
    srv = await startServer({
      pipeline: true,
      inference: () => createMockInference({ scenarios, force: 'r01-brand-switch', active: () => ({ name: 'yolo11s-s0-20261025', names: [] }) }),
    });
    admin = client(srv.base);
    await admin.login(ADMIN);
    token = (await admin.post('/api/admin/carts/A-07/device-token')).json.token;
  });
  after(() => srv.close());

  test('BRAND_SWITCH reaches /ws/admin as soon as the frame that finalized it is processed', async () => {
    const sid = (await client(srv.base).post('/api/sessions', { cart: 'A-07' })).json.session_id;
    const watcher = await openWs(`${srv.wsBase}/ws/admin`, { cookie: admin.cookie });
    const reasons = [];
    watcher.ws.on('message', (data, bin) => { if (!bin) { const m = JSON.parse(data); if (m.type === 'change_reason') reasons.push({ ...m, at: Date.now() }); } });
    const { ws, next } = await openWs(`${srv.wsBase}/ws/device/A-07?token=${token}`);
    const frames = scenarios.get('r01-brand-switch').frames.length;
    let processedAt = new Map();
    for (let seq = 1; seq <= frames; seq++) {
      ws.send(Buffer.concat([Buffer.from(JSON.stringify({ seq }) + '\n'), Buffer.from([0xff, 0xd8, 0xff, 0xd9])]));
      await next('ack');
      await next('processed');
      processedAt.set(seq, Date.now());
    }
    await new Promise((r) => setTimeout(r, 100));
    const final = reasons.find((m) => m.status === 'final');
    assert.ok(final, 'final reason pushed');
    assert.equal(final.reason_code, 'BRAND_SWITCH');
    assert.equal(final.cart, 'A-07');
    assert.equal(final.session_id, sid);
    const row = srv.db.prepare("SELECT status, reason_code, decided_at_ms FROM change_reasons WHERE session_id = ? AND status = 'final'").get(sid);
    assert.equal(row.reason_code, 'BRAND_SWITCH');
    // pushed right after the commit, well within 1 s
    assert.ok(final.at - Math.max(...[...processedAt.values()].filter((t) => t <= final.at)) < 1000);
    ws.close();
    watcher.ws.close();
  });
});

describe('reasons in the admin API', () => {
  test('session detail, cart detail and /analytics/reasons expose reasons and hidden units', async () => {
    const srv = await startServer({
      pipeline: true,
      inference: () => createMockInference({ scenarios, force: 'r07-occluded', active: () => ({ name: 'yolo11s-s0-20261025', names: [] }) }),
    });
    try {
      const admin = client(srv.base);
      await admin.login(ADMIN);
      const token = (await admin.post('/api/admin/carts/A-07/device-token')).json.token;
      const sid = (await client(srv.base).post('/api/sessions', { cart: 'A-07' })).json.session_id;
      const { ws, next } = await openWs(`${srv.wsBase}/ws/device/A-07?token=${token}`);
      for (let seq = 1; seq <= scenarios.get('r07-occluded').frames.length; seq++) {
        ws.send(Buffer.concat([Buffer.from(JSON.stringify({ seq }) + '\n'), Buffer.from([0xff, 0xd8, 0xff, 0xd9])]));
        await next('ack');
        await next('processed');
      }
      ws.close();
      const cart = (await admin.get('/api/admin/carts/A-07')).json;
      const hidden = cart.session.presence.find((p) => p.state === 'OCCLUDED');
      assert.equal(hidden.class_name, 'lay_big_ori');
      assert.equal(hidden.occluded_by, 'bengbeng_pack12');
      assert.equal(hidden.last_box.length, 4);
      assert.deepEqual(cart.session.reasons, []);
      // checkout while hidden: price kept + OCCLUDED_AT_CHECKOUT (test 12 through the API)
      const closed = (await admin.post(`/api/sessions/${sid}/checkout`, {})).json;
      assert.equal(closed.items.length, 2);
      const alerts = (await admin.get('/api/admin/alerts')).json.alerts.map((a) => a.alert_type);
      assert.ok(alerts.includes('OCCLUDED_AT_CHECKOUT'));
      const detail = (await admin.get(`/api/admin/sessions/${sid}`)).json;
      assert.ok(Array.isArray(detail.reasons));
      const summary = (await admin.get('/api/admin/analytics/reasons')).json;
      assert.ok(Array.isArray(summary.summary) && Array.isArray(summary.pairs));
    } finally {
      await srv.close();
    }
  });
});
