// Cart model for Phase 6: presence engine + reason engine, persisted to SQLite (same interface as cartModel.js).
//   cart_item_presence  SCD2 per unit (close the current row, open a new one; never UPDATE the state in place)
//   cart_events          ADD / REMOVE / CORRECTION (qty ±1 per unit, price snapshot at ADD)
//   change_reasons       pending -> final / voided
//   alerts               MODEL_FLIP, OCCLUDED_AT_CHECKOUT
// Admins get cart_event, presence and change_reason messages on /ws/admin as soon as they are written.
import { applyItemChange } from './persist.js';
import { createPresenceEngine } from './presence.js';
import { createReasonEngine, REASON_LABELS, RULE_VERSION } from './reasons.js';
import { raiseAlert } from '../services/alerts.js';

const cache = new WeakMap();
function sql(db) {
  if (cache.has(db)) return cache.get(db);
  const s = {
    product: db.prepare('SELECT product_id, class_name, name_th, brand, product_line, flavor, variant, category, sub_category FROM products WHERE product_id = ?'),
    price: db.prepare(`SELECT COALESCE(promo_price, price) FROM product_prices WHERE product_id = ? AND is_current = 1
                       AND (store_id IS NULL OR store_id = ?) ORDER BY store_id IS NULL LIMIT 1`).pluck(),
    closePresence: db.prepare('UPDATE cart_item_presence SET valid_to_ms = ?, is_current = 0 WHERE presence_id = ?'),
    openPresence: db.prepare(`INSERT INTO cart_item_presence (session_id, product_id, unit_no, local_track_id, state, change_cause,
        occluded_by_product_id, last_seen_ms, last_box, valid_from_ms, caused_by_event_id)
      VALUES (@session_id, @product_id, @unit_no, @local_track_id, @state, @change_cause, @occluded_by_product_id, @last_seen_ms,
        @last_box, @valid_from_ms, @caused_by_event_id)`),
    insertReason: db.prepare(`INSERT INTO change_reasons (session_id, reason_code, status, from_product_id, to_product_id, remove_event_id,
        add_event_id, qty_before, qty_after, price_delta, dwell_ms, gap_ms, rule_version, evidence, decided_at_ms)
      VALUES (@session_id, @reason_code, @status, @from_product_id, @to_product_id, @remove_event_id, @add_event_id, @qty_before,
        @qty_after, @price_delta, @dwell_ms, @gap_ms, @rule_version, @evidence, @decided_at_ms)`),
    updateReason: db.prepare(`UPDATE change_reasons SET reason_code = @reason_code, status = @status, to_product_id = @to_product_id,
        add_event_id = @add_event_id, qty_before = @qty_before, qty_after = @qty_after, price_delta = @price_delta, dwell_ms = @dwell_ms,
        gap_ms = @gap_ms, evidence = @evidence, decided_at_ms = @decided_at_ms WHERE reason_id = @reason_id`),
  };
  cache.set(db, s);
  return s;
}

/**
 * @param {{ db: import('better-sqlite3').Database, writer: any, hub: any, cfg: any, log?: any, sessionId: string,
 *           cart: { cart_id: number, store_id: number, label: string } }} deps
 */
export function createPresenceModel({ db, writer, hub, cfg, log, sessionId, cart }) {
  const s = sql(db);
  const attrsCache = new Map();
  const attrs = (id) => {
    if (!attrsCache.has(id)) attrsCache.set(id, s.product.get(id));
    return attrsCache.get(id);
  };
  const engine = createPresenceEngine({ W: cfg.TRACKER_WINDOW ?? 8, priceOf: (id) => s.price.get(id, cart.store_id) ?? null });
  const reasons = createReasonEngine({ windowMs: cfg.REASON_PAIR_WINDOW_MS ?? 60_000, attrs });
  const eventIds = new Map();   // engine event key -> cart_events.event_id
  const reasonIds = new Map();  // reason key -> change_reasons.reason_id
  const presenceIds = new Map(); // unit uid -> current cart_item_presence.presence_id
  let finalized = false;

  const productMsg = (id, qty) => { const p = attrs(id); return p ? { class_name: p.class_name, name_th: p.name_th, qty } : null; };

  function reasonMessage(r, id) {
    const label = REASON_LABELS[r.code];
    return {
      type: 'change_reason', cart: cart.label, session_id: sessionId, reason_id: id, status: r.status, reason_code: r.code,
      label_th: label.th, tone: label.tone,
      from: productMsg(r.fromProductId, r.qtyBefore), to: r.toProductId ? productMsg(r.toProductId, r.kind === 'increase' ? r.qtyAfter : 1) : null,
      qty_before: r.qtyBefore, qty_after: r.qtyAfter, price_delta: r.priceDelta, dwell_ms: r.dwellMs, gap_ms: r.gapMs,
      pending_until_ms: r.status === 'pending' ? r.removeAt + (cfg.REASON_PAIR_WINDOW_MS ?? 60_000) : null, t: r.decidedAt,
    };
  }

  /** Write reason rows; returns admin messages. */
  function persistReasons(d, list) {
    const msgs = [];
    for (const r of list) {
      const row = {
        session_id: sessionId, reason_code: r.code, status: r.status, from_product_id: r.fromProductId, to_product_id: r.toProductId,
        remove_event_id: r.removeKey ? eventIds.get(r.removeKey) ?? null : null, add_event_id: r.addKey ? eventIds.get(r.addKey) ?? null : null,
        qty_before: r.qtyBefore, qty_after: r.qtyAfter, price_delta: r.priceDelta, dwell_ms: r.dwellMs, gap_ms: r.gapMs,
        rule_version: RULE_VERSION, evidence: JSON.stringify(r.evidence), decided_at_ms: r.decidedAt,
      };
      let id = reasonIds.get(r.key);
      if (id) s.updateReason.run({ ...row, reason_id: id });
      else { id = Number(s.insertReason.run(row).lastInsertRowid); reasonIds.set(r.key, id); }
      msgs.push(reasonMessage(r, id));
    }
    return msgs;
  }

  function presenceRow(d, u, state, cause, at, eventId = null, occludedBy = null) {
    const cur = presenceIds.get(u.uid);
    if (cur) s.closePresence.run(at, cur);
    const id = Number(s.openPresence.run({
      session_id: sessionId, product_id: u.productId, unit_no: u.unitNo, local_track_id: u.trackId ?? null, state, change_cause: cause,
      occluded_by_product_id: occludedBy, last_seen_ms: u.lastSeenT ?? null, last_box: u.lastBox ? JSON.stringify(u.lastBox.map((v) => Math.round(v * 1e4) / 1e4)) : null,
      valid_from_ms: at, caused_by_event_id: eventId,
    }).lastInsertRowid);
    presenceIds.set(u.uid, id);
  }

  /** Apply engine actions in one transaction; returns admin messages. */
  function apply(d, actions, frameId, frameSeq) {
    const msgs = [];
    const event = (u, delta, type, at, extra = {}) => {
      const confs = u.confs ?? [];
      const r = applyItemChange(d, { sessionId, storeId: cart.store_id, productId: u.productId, delta, eventType: type, frameId,
        trackId: u.trackId ?? null, confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null, at, ...extra });
      msgs.push({ type: 'cart_event', cart: cart.label, session_id: sessionId, event_id: r.event_id, event_type: type,
        class_name: u.className, qty_delta: r.qty_after - r.qty_before, qty_after: r.qty_after, unit_price: r.unit_price, frame_seq: frameSeq, t: at });
      return r;
    };
    for (const a of actions) {
      const u = a.unit;
      if (a.kind === 'add') {
        const r = event(u, +1, 'ADD', a.at);
        const key = `a${u.uid}`;
        eventIds.set(key, r.event_id);
        presenceRow(d, u, 'IN_CART', 'ADDED', a.at, r.event_id);
        msgs.push(...persistReasons(d, reasons.onAdd({ key, productId: u.productId, at: a.at, qtyBefore: r.qty_before, qtyAfter: r.qty_after, unitPrice: r.unit_price })));
      } else if (a.kind === 'remove') {
        const r = event(u, -1, 'REMOVE', a.at, { note: `exit evidence: ${JSON.stringify(a.evidence)}` });
        const key = `r${u.uid}-${a.confirmedAt}`;
        u.removeKey = key;
        eventIds.set(key, r.event_id);
        presenceRow(d, u, 'REMOVED', 'EXIT_EVIDENCE', a.at, r.event_id);
        msgs.push(...persistReasons(d, reasons.onRemove({ key, productId: u.productId, at: a.at, decidedAt: a.confirmedAt,
          qtyBefore: r.qty_before, qtyAfter: r.qty_after, unitPrice: u.unitPrice ?? r.unit_price, dwellMs: a.at - u.addedAt })));
      } else if (a.kind === 'state') {
        presenceRow(d, u, a.to, a.cause, a.at, null, a.occludedBy ?? null);
        msgs.push({ type: 'presence', cart: cart.label, session_id: sessionId, class_name: u.className, unit_no: u.unitNo, state: a.to,
          cause: a.cause, occluded_by: a.occludedBy ? attrs(a.occludedBy)?.class_name ?? null : null, last_box: u.lastBox, t: a.at });
      } else if (a.kind === 'correction') {
        const r = event(u, +1, 'CORRECTION', a.at, { note: 'REMOVE ผิด: เห็นชิ้นเดิมในตะกร้าอีกครั้งภายใน 10 วินาที' });
        presenceRow(d, u, 'IN_CART', 'CORRECTION', a.at, r.event_id);
        msgs.push(...persistReasons(d, reasons.voidRemove(u.removeKey, a.at)));
        u.removeKey = null;
      } else if (a.kind === 'flip_alert') {
        raiseAlert(d, hub, { type: 'MODEL_FLIP', cartId: cart.cart_id, sessionId,
          message: `${cart.label} · ${u.className} → ${a.toClass} ที่ตำแหน่งเดิม conf ${a.conf.toFixed(2)} (ไม่นับเป็นหยิบเข้า–ออก)`,
          payload: { unit_no: u.unitNo, from: u.className, to: a.toClass, conf: a.conf, box: u.lastBox } });
      } else if (a.kind === 'flip_correct') {
        const nu = a.newUnit;
        const r1 = event(u, -1, 'CORRECTION', a.at, { note: `model flip: ${a.fromClass} -> ${a.toClass}` });
        presenceRow(d, u, 'REMOVED', 'CORRECTION', a.at, r1.event_id);
        const r2 = event(nu, +1, 'CORRECTION', a.at, { note: `model flip: ${a.fromClass} -> ${a.toClass}` });
        presenceRow(d, nu, 'IN_CART', 'CORRECTION', a.at, r2.event_id);
      }
    }
    return msgs;
  }

  return {
    update({ job, tracker, dets, catalog, roi }) {
      const { actions } = engine.step({ t: job.t.received, dets, stable: tracker.stable, roi, catalog, scale: tracker.scale ?? 1 });
      const due = reasons.tick(job.t.received);
      const messages = [];
      const itemChange = actions.some((a) => a.kind !== 'state' && a.kind !== 'flip_alert');
      return {
        events: actions.length || due.length ? [...actions, ...due] : [],
        changed: itemChange || actions.some((a) => a.kind === 'state'),
        messages,
        persist(d, frameId) {
          messages.push(...apply(d, actions, frameId, job.seq));
          messages.push(...persistReasons(d, due));
        },
      };
    },
    /** Called every second by the pipeline: reasons whose window closed become final even without frames. */
    tick(now) {
      if (finalized) return;
      const due = reasons.tick(now);
      if (!due.length) return;
      const msgs = writer.now((d) => persistReasons(d, due));
      for (const m of msgs) hub.toAdmins(m);
    },
    /** Checkout (session_closing): finalize reasons, close presence rows, alert on hidden items. */
    finalize() {
      if (finalized) return;
      finalized = true;
      const now = Date.now();
      const { actions } = engine.finalize(now);
      const occluded = actions.filter((a) => a.wasOccluded);
      const msgs = writer.now((d) => {
        for (const a of actions) presenceRow(d, a.unit, 'REMOVED', 'CHECKOUT', now);
        const m = persistReasons(d, reasons.finalizeAll(now));
        if (occluded.length) {
          raiseAlert(d, hub, { type: 'OCCLUDED_AT_CHECKOUT', cartId: cart.cart_id, sessionId,
            message: `${cart.label} · มีสินค้าถูกบัง ${occluded.length} ชิ้นตอนชำระเงิน ให้พนักงานตรวจ: ${[...new Set(occluded.map((a) => a.unit.className))].join(', ')}`,
            payload: { units: occluded.map((a) => ({ class_name: a.unit.className, unit_no: a.unit.unitNo, last_box: a.unit.lastBox })) } });
        }
        return m;
      });
      for (const m of msgs) hub.toAdmins(m);
      log?.debug({ sessionId, occluded: occluded.length }, 'presence finalized');
    },
    close() {},
    /** For the Live page: items with how many units are hidden right now. */
    items: () => engine.items(),
    engine, reasons,
  };
}
