// Reason engine (brief section 7.5, rule_version v1) — pure: events + product attributes in, decisions out.
// No I/O and no clock: every call carries the time, so scenario tests can run in virtual time.
//
// A confirmed REMOVE of X opens a reason; it is paired with an unpaired ADD of Y within ±windowMs
// (the ADD may come first). Rules in priority order, first match wins, then the closest in time:
//   1 BRAND_SWITCH    same sub_category, different brand   (sub_category: user decision 2026-11-03)
//   2 FLAVOR_SWITCH   same brand + product_line, different flavor
//   3 VARIANT_SWITCH  same brand + product_line + flavor, different variant
//   4 QTY_CHANGE      same product: REMOVE then ADD back = net zero -> voided;
//                     REMOVE with X still in the cart and no Y -> decrease; ADD of X already in the cart
//                     more than 30 s after its previous ADD -> increase
//   5 ABANDON         REMOVE leaving 0 of X and no Y in the window (a Y of another category stays a plain ADD)
//
// Pairing and finality: a rule-1 pair is final at once (nothing can outrank it). A rank 2-4 pair is
// tentative: the reason stays pending until the window closes, and a better ADD arriving meanwhile takes
// its place (test 10: lay_big_nori first, pringles later -> BRAND_SWITCH with pringles).
export const RULE_VERSION = 'v1';
export const REASON_LABELS = {
  BRAND_SWITCH: { th: 'เปลี่ยนแบรนด์', tone: 'primary' },
  FLAVOR_SWITCH: { th: 'เปลี่ยนรสชาติ/กลิ่น', tone: 'success' },
  VARIANT_SWITCH: { th: 'เปลี่ยนขนาด/แพ็ก', tone: 'warning' },
  QTY_CHANGE: { th: 'เพิ่ม/ลดจำนวน', tone: 'neutral' },
  ABANDON: { th: 'ยกเลิกการซื้อ', tone: 'danger' },
};

/**
 * Which switch rule pairs X (removed) with Y (added)? null when none of rules 1-3 applies.
 * @param {{ brand?: string, product_line?: string, flavor?: string, variant?: string, sub_category?: string }} x
 * @param {typeof x} y
 */
export function switchRule(x, y) {
  if (!x || !y) return null;
  if (x.sub_category && x.sub_category === y.sub_category && x.brand !== y.brand) return { code: 'BRAND_SWITCH', rank: 1, diff: ['brand'] };
  if (x.brand === y.brand && x.product_line === y.product_line) {
    if (x.flavor !== y.flavor) return { code: 'FLAVOR_SWITCH', rank: 2, diff: x.variant !== y.variant ? ['flavor', 'variant'] : ['flavor'] };
    if (x.variant !== y.variant) return { code: 'VARIANT_SWITCH', rank: 3, diff: ['variant'] };
  }
  return null;
}

const pickAttrs = (a) => (a ? { class_name: a.class_name, brand: a.brand, product_line: a.product_line, flavor: a.flavor, variant: a.variant, sub_category: a.sub_category } : null);

/**
 * @param {{ windowMs?: number, qtyAddGapMs?: number, attrs: (productId: number) => object|undefined }} opts
 */
export function createReasonEngine({ windowMs = 60_000, qtyAddGapMs = 30_000, attrs }) {
  let nextKey = 1;
  /** @type {Map<number, any>} reason key -> reason */
  const reasons = new Map();
  /** ADD events seen in the last window: { key, productId, at, qtyBefore, qtyAfter, unitPrice, paired } */
  let adds = [];
  /** productId -> time of the last ADD (for "came back for more" increases) */
  const lastAdd = new Map();
  let changed = new Set();

  const flush = () => {
    const out = [...changed].map((r) => ({ ...r, evidence: { ...r.evidence } }));
    changed = new Set();
    return out;
  };
  const touch = (r) => changed.add(r);

  /** Rule between a pending REMOVE and an ADD, or null. Same product = net zero (rank 4). */
  function ruleFor(r, add) {
    // same product only counts when it is put back AFTER the REMOVE (an earlier ADD is what brought it in)
    if (add.productId === r.fromProductId) return add.at > r.removeAt ? { code: 'QTY_CHANGE', rank: 4, diff: [], netZero: true } : null;
    return switchRule(attrs(r.fromProductId), attrs(add.productId));
  }
  const better = (rule, dt, cur) => !cur || rule.rank < cur.rule.rank || (rule.rank === cur.rule.rank && dt < cur.dt);

  function setIncreaseVoided(add, at) {
    for (const q of reasons.values()) {
      if (q.kind === 'increase' && q.addKey === add.key && q.status === 'pending') {
        Object.assign(q, { status: 'voided', decidedAt: at, evidence: { ...q.evidence, voided_by: 'PAIRED_WITH_REMOVE' } });
        touch(q);
      }
    }
  }

  /** Attach `add` to reason `r` with `rule` (tentative unless rank 1). */
  function pair(r, add, rule, dt, at) {
    if (r.tentative && r.tentative.add !== add) r.tentative.add.paired = null; // the previous candidate is free again
    add.paired = r.key;
    setIncreaseVoided(add, at);
    r.tentative = { add, rule, dt };
    const x = attrs(r.fromProductId), y = attrs(add.productId);
    Object.assign(r, {
      code: rule.netZero ? r.provisional : rule.code, toProductId: add.productId, addKey: add.key, gapMs: dt,
      priceDelta: add.unitPrice != null && r.fromUnitPrice != null ? Math.round((add.unitPrice - r.fromUnitPrice) * 100) / 100 : null,
      decidedAt: at, evidence: { ...r.evidence, rule: rule.netZero ? 'NET_ZERO' : rule.code, differs: rule.diff, from: pickAttrs(x), to: pickAttrs(y) },
    });
    if (rule.rank === 1) close(r, at);
    touch(r);
  }

  /** Decide a pending reason now. */
  function close(r, at, extra = {}) {
    if (r.status !== 'pending') return;
    const t = r.tentative;
    if (t?.rule.netZero) r.status = 'voided';
    else r.status = 'final';
    if (!t && !r.evidence.rule) r.evidence = { ...r.evidence, rule: r.code === 'ABANDON' ? 'NO_REPLACEMENT' : 'QTY_DECREASE' };
    r.decidedAt = at;
    Object.assign(r.evidence, extra);
    touch(r);
  }

  return {
    /**
     * Confirmed REMOVE.
     * @param {{ key: string, productId: number, at: number, qtyBefore: number, qtyAfter: number, unitPrice: number|null, dwellMs: number|null, decidedAt?: number }} ev
     *   at = when the item was last seen (pairing / gap), decidedAt = when the REMOVE was confirmed
     * @returns {object[]} reasons created or changed
     */
    onRemove(ev) {
      const at = ev.decidedAt ?? ev.at;
      const provisional = ev.qtyAfter >= 1 ? 'QTY_CHANGE' : 'ABANDON'; // what it becomes if nothing replaces it
      const r = {
        key: nextKey++, kind: 'remove', status: 'pending', code: provisional, provisional,
        fromProductId: ev.productId, toProductId: null, removeKey: ev.key, addKey: null,
        qtyBefore: ev.qtyBefore, qtyAfter: ev.qtyAfter, fromUnitPrice: ev.unitPrice, priceDelta: null,
        dwellMs: ev.dwellMs, gapMs: null, removeAt: ev.at, decidedAt: at, tentative: null,
        evidence: { rule_version: RULE_VERSION },
      };
      reasons.set(r.key, r);
      touch(r);
      let best = null;
      for (const a of adds) {
        if (a.paired || Math.abs(a.at - r.removeAt) > windowMs) continue;
        const rule = ruleFor(r, a);
        const dt = Math.abs(a.at - r.removeAt);
        if (rule && better(rule, dt, best)) best = { a, rule, dt };
      }
      if (best) pair(r, best.a, best.rule, best.dt, at);
      return flush();
    },

    /**
     * Confirmed ADD.
     * @param {{ key: string, productId: number, at: number, qtyBefore: number, qtyAfter: number, unitPrice: number|null }} ev
     */
    onAdd(ev) {
      const add = { ...ev, paired: null };
      adds.push(add);
      // the pending REMOVE this ADD fits best, if it beats what that REMOVE already has
      let best = null;
      for (const r of reasons.values()) {
        if (r.kind !== 'remove' || r.status !== 'pending' || Math.abs(ev.at - r.removeAt) > windowMs) continue;
        const rule = ruleFor(r, add);
        if (!rule) continue;
        const dt = Math.abs(ev.at - r.removeAt);
        if (r.tentative && !better(rule, dt, r.tentative)) continue;
        if (better(rule, dt, best)) best = { r, rule, dt };
      }
      if (best) {
        pair(best.r, add, best.rule, best.dt, ev.at);
      } else if (ev.qtyBefore >= 1 && lastAdd.has(ev.productId) && ev.at - lastAdd.get(ev.productId) > qtyAddGapMs) {
        // came back for one more of something already in the cart
        const q = {
          key: nextKey++, kind: 'increase', status: 'pending', code: 'QTY_CHANGE', provisional: 'QTY_CHANGE',
          fromProductId: ev.productId, toProductId: ev.productId, removeKey: null, addKey: ev.key,
          qtyBefore: ev.qtyBefore, qtyAfter: ev.qtyAfter, fromUnitPrice: ev.unitPrice, priceDelta: 0,
          dwellMs: null, gapMs: ev.at - lastAdd.get(ev.productId), removeAt: ev.at, decidedAt: ev.at, tentative: null,
          evidence: { rule_version: RULE_VERSION, rule: 'QTY_INCREASE' },
        };
        reasons.set(q.key, q);
        touch(q);
      }
      lastAdd.set(ev.productId, ev.at);
      return flush();
    },

    /** The REMOVE was wrong (item seen again in the cart): void its reason and free its ADD. */
    voidRemove(removeKey, at) {
      for (const r of reasons.values()) {
        if (r.removeKey !== removeKey || r.status === 'voided') continue;
        if (r.tentative) r.tentative.add.paired = null;
        Object.assign(r, { status: 'voided', decidedAt: at, evidence: { ...r.evidence, voided_by: 'CORRECTION' } });
        touch(r);
      }
      return flush();
    },

    /** Window over: pending reasons become final (or voided when the best pair was the same product back). */
    tick(now) {
      for (const r of reasons.values()) if (r.status === 'pending' && now - r.removeAt > windowMs) close(r, now);
      adds = adds.filter((a) => now - a.at <= windowMs);
      return flush();
    },

    /** Checkout: decide everything now. */
    finalizeAll(now) {
      for (const r of reasons.values()) close(r, now, { finalized: 'checkout' });
      return flush();
    },

    all: () => [...reasons.values()].map((r) => ({ ...r, evidence: { ...r.evidence } })),
  };
}
