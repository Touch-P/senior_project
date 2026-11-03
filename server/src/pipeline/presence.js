// Presence engine (brief 7.1-7.3) — one state machine per physical item, pure (time comes with each frame).
//
// Main rule: disappearing from the image is NOT taking the item out. A unit becomes REMOVED only with exit
// evidence (7.2): last seen in the ROI edge band, moving towards the edge, nothing covering its last box,
// and gone for 2W frames while the stable count of its class really dropped. Without it the unit is
// OCCLUDED (still in the cart, still paid for). A box of another class at the same place right after
// the unit vanished is a model flip (7.3), not REMOVE + ADD.
//
// step() returns actions for the cart model to persist; it never touches the database.
import { center, coverage, crossesEdge, distToEdge, distToEdgeAt, iou, nearestEdge, pointInPolygon, polygonSize } from './geometry.js';

/**
 * @typedef {{ kind: 'add'|'remove'|'state'|'correction'|'flip_alert'|'flip_correct', unit: object, [k: string]: any }} Action
 */

export const PRESENCE_DEFAULTS = {
  W: 8,                  // tracker window (frames)
  occludeAfter: 3,       // IN_CART -> OCCLUDED after more than this many missing frames
  edgeBand: 0.12,        // share of the ROI size counted as "near the edge"
  minOutward: 0.02,      // total move towards the edge over the last frames (normalised units)
  noise: 0.01,           // per-step tolerance of that distance (box jitter)
  occlusionCoverage: 0.3,
  flipIou: 0.5,
  flipWindowMs: 2000,
  correctionMs: 10_000,
};

/**
 * @param {Partial<typeof PRESENCE_DEFAULTS> & { priceOf?: (productId: number) => number|null }} [opts]
 */
export function createPresenceEngine(opts = {}) {
  const o = { ...PRESENCE_DEFAULTS, ...opts };
  const priceOf = opts.priceOf ?? (() => null);
  /** @type {any[]} */
  const units = [];
  const unitNo = new Map();       // productId -> last unit_no used in this session
  const trackHist = new Map();    // local_track_id -> first centres (entry evidence)
  let frame = 0, nextUid = 1;

  const active = (u) => u.state === 'IN_CART' || u.state === 'OCCLUDED';
  const countActive = (cls) => units.filter((u) => active(u) && u.className === cls).length;
  const qtyOf = (productId) => units.filter((u) => active(u) && u.productId === productId).length;

  function edgeDist(box, roi) { return distToEdge(center(box), roi); }

  /** 7.2 items 1-2: last position in the edge band (or straddling the border) and moving towards the edge. */
  function exitEvidence(u, roi, band) {
    if (!u.lastBox) return { near: false, outward: false };
    const near = edgeDist(u.lastBox, roi) <= band || crossesEdge(u.lastBox, roi);
    // last 3-4 sightings: the distance to the edge the item leaves through (the edge nearest to the last
    // sighting) goes down — noise up to o.noise per step allowed, the last step strictly
    const pts = u.hist.slice(-4);
    const edge = pts.length ? nearestEdge(pts.at(-1), roi) : 0;
    const h = pts.map((p) => distToEdgeAt(p, roi, edge));
    let outward = false;
    if (h.length >= 3) {
      const steps = h.slice(1).map((d, i) => d - h[i]);
      outward = steps.every((s) => s <= o.noise) && steps.at(-1) < 0 && h[0] - h.at(-1) >= o.minOutward;
    }
    return { near, outward };
  }

  /** Entry evidence of a new box: its first sighting was at the edge and it moved away from that edge. */
  function entryEvidence(det, roi, band) {
    const pts = trackHist.get(det.local_track_id);
    if (!pts || !pts.length) return false;
    const edge = nearestEdge(pts[0], roi);
    const h = pts.map((p) => distToEdgeAt(p, roi, edge));
    if (h[0] > band) return false;
    return h.length < 3 || h.at(-1) - h[0] >= o.minOutward / 2;
  }

  function see(u, d, t, roi, actions) {
    if (u.state === 'OCCLUDED') {
      actions.push({ kind: 'state', unit: u, from: 'OCCLUDED', to: 'IN_CART', cause: 'SEEN_AGAIN', at: t });
      u.state = 'IN_CART';
      u.occludedBy = null;
    }
    u.missing = 0;
    u.exit = null;
    u.lastBox = d.box;
    u.lastSeenT = t;
    u.lastSeenFrame = frame;
    if (d.local_track_id != null) u.trackId = d.local_track_id;
    u.hist.push(center(d.box));
    if (u.hist.length > 8) u.hist.shift();
    if (d.class_name === u.className) {
      u.confs.push(d.conf);
      if (u.confs.length > 16) u.confs.shift();
      u.flip = null;
    }
  }

  function newUnit(productId, className, t) {
    const no = (unitNo.get(productId) ?? 0) + 1;
    unitNo.set(productId, no);
    const u = { uid: nextUid++, productId, className, unitNo: no, state: 'IN_CART', trackId: null, lastBox: null,
      lastSeenT: t, lastSeenFrame: frame, missing: 0, hist: [], confs: [], addedAt: t, unitPrice: priceOf(productId),
      exit: null, occludedBy: null, flip: null, removedAt: null, removeKey: null };
    units.push(u);
    return u;
  }

  /**
   * @param {{ t: number, dets: import('./postprocess.js').Det[], stable: Map<string, number>, roi: number[][],
   *           catalog: Map<string, { product_id: number }> }} f
   * @returns {{ actions: Action[] }}
   */
  function step({ t, dets, stable, roi, catalog }) {
    frame++;
    const actions = [];
    const band = o.edgeBand * polygonSize(roi);
    const accepted = dets.filter((d) => d.accepted);
    const inRoi = dets.filter((d) => d.in_roi);
    for (const d of accepted) {
      if (d.local_track_id == null) continue;
      const h = trackHist.get(d.local_track_id) ?? [];
      if (h.length < 6) h.push(center(d.box));
      trackHist.set(d.local_track_id, h);
    }

    // ---- 1. match boxes to units
    const free = new Set(accepted);
    const seen = new Set();
    const take = (u, d) => { free.delete(d); seen.add(u); see(u, d, t, roi, actions); };
    const live = units.filter(active);
    // a) same local track id
    for (const u of live) {
      const d = [...free].find((x) => x.class_name === u.className && u.trackId != null && x.local_track_id === u.trackId);
      if (d) take(u, d);
    }
    // b) IN_CART units: nearby box of the same class
    for (const u of live) {
      if (seen.has(u) || u.state !== 'IN_CART') continue;
      let best = null, score = -1;
      for (const d of free) {
        if (d.class_name !== u.className) continue;
        const s = u.lastBox ? Math.max(iou(u.lastBox, d.box), 0.15 - Math.hypot(...center(u.lastBox).map((v, i) => v - center(d.box)[i]))) : 1;
        if (s > 0 && s > score) { best = d; score = s; }
      }
      if (best) take(u, best);
    }
    // b2) still unmatched IN_CART units: the remaining box of the same class nearest to the last position
    //     (an item moved fast enough that consecutive boxes do not overlap)
    for (const u of live) {
      if (seen.has(u) || u.state !== 'IN_CART') continue;
      let best = null, bestD = Infinity;
      for (const d of free) {
        if (d.class_name !== u.className) continue;
        const dist = u.lastBox ? Math.hypot(...center(u.lastBox).map((v, i) => v - center(d.box)[i])) : 0;
        if (dist < bestD) { best = d; bestD = dist; }
      }
      if (best) take(u, best);
    }
    // c) OCCLUDED units come back when their class is seen again (7.1: SEEN_AGAIN, never a new ADD)
    for (const u of live) {
      if (seen.has(u) || u.state !== 'OCCLUDED') continue;
      let best = null, bestD = Infinity;
      for (const d of free) {
        if (d.class_name !== u.className) continue;
        const dist = u.lastBox ? Math.hypot(...center(u.lastBox).map((v, i) => v - center(d.box)[i])) : 0;
        if (dist < bestD) { best = d; bestD = dist; }
      }
      if (best) take(u, best);
    }
    // d) model flip: the unit vanished and another class sits on its last box (any confidence)
    const flipUsed = new Map();
    for (const u of live) {
      if (seen.has(u) || u.state !== 'IN_CART' || !u.lastBox) continue;
      if (t - u.lastSeenT > o.flipWindowMs && !u.flip) continue;
      const cand = inRoi.filter((d) => d.class_name !== u.className && (d.accepted ? free.has(d) : true) && iou(u.lastBox, d.box) >= o.flipIou)
        .sort((a, b) => iou(u.lastBox, b.box) - iou(u.lastBox, a.box))[0];
      if (!cand) continue;
      const ex = exitEvidence(u, roi, band);
      if (ex.near && ex.outward) continue; // it really left; the other box is a new item
      if (cand.accepted) { free.delete(cand); flipUsed.set(cand.class_name, (flipUsed.get(cand.class_name) ?? 0) + 1); }
      if (!u.flip || u.flip.toClass !== cand.class_name) u.flip = { toClass: cand.class_name, since: t, frames: 0, confs: [], alerted: false };
      u.flip.frames++;
      u.flip.confs.push(cand.conf);
      u.missing = 0;
      u.lastSeenT = t;
      u.lastSeenFrame = frame;
      seen.add(u);
      if (!u.flip.alerted) {
        u.flip.alerted = true;
        actions.push({ kind: 'flip_alert', unit: u, toClass: cand.class_name, conf: cand.conf, at: t });
      }
      const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
      const target = catalog.get(cand.class_name);
      if (target && u.flip.frames >= 2 * o.W && avg(u.flip.confs) > avg(u.confs)) {
        // the new class is stable and more confident: the item was misclassified from the start
        const fromClass = u.className, fromProductId = u.productId;
        actions.push({ kind: 'flip_correct', unit: u, fromClass, fromProductId, toClass: cand.class_name, toProductId: target.product_id, at: t });
        u.state = 'REMOVED';
        u.removedAt = t;
        const nu = newUnit(target.product_id, cand.class_name, t);
        nu.addedAt = u.addedAt;
        nu.lastBox = cand.box;
        nu.confs = [...u.flip.confs];
        actions.at(-1).newUnit = nu;
      }
    }

    // ---- 2. units not seen in this frame
    for (const u of live) {
      if (seen.has(u) || !active(u)) continue;
      u.missing++;
      if (u.missing === 1) {
        // judge the exit evidence at the moment the unit disappears
        const ex = exitEvidence(u, roi, band);
        const others = inRoi.filter((d) => d.local_track_id == null || d.local_track_id !== u.trackId);
        let cov = 0, by = null;
        for (const d of others) { const c = coverage(u.lastBox ?? [0, 0, 0, 0], d.box); if (c > cov) { cov = c; by = d; } }
        // seen just outside the ROI at the same place: it is on its way out
        const outside = dets.some((d) => !d.in_roi && d.class_name === u.className && u.lastBox && iou(u.lastBox, d.box) > 0);
        u.exit = (ex.near && (ex.outward || outside)) && cov < o.occlusionCoverage ? { near: ex.near, outward: ex.outward, outside } : null;
        u.occludedBy = cov >= o.occlusionCoverage ? (catalog.get(by.class_name)?.product_id ?? null) : null;
        u.occludedCoverage = cov;
      }
      if (u.state === 'IN_CART') {
        if (u.exit) {
          const stableN = (stable.get(u.className) ?? 0) - (flipUsed.get(u.className) ?? 0);
          if (u.missing >= 2 * o.W && stableN < countActive(u.className)) {
            u.state = 'REMOVED';
            u.removedAt = t;
            actions.push({ kind: 'remove', unit: u, at: u.lastSeenT, confirmedAt: t, evidence: { ...u.exit, missing_frames: u.missing },
              qtyBefore: qtyOf(u.productId) + 1, qtyAfter: qtyOf(u.productId) });
          } else if (u.missing >= 4 * o.W) {
            u.exit = null; // waited long enough without the count dropping: treat as hidden
          }
        }
        if (!u.exit && u.state === 'IN_CART' && u.missing > o.occludeAfter) {
          u.state = 'OCCLUDED';
          actions.push({ kind: 'state', unit: u, from: 'IN_CART', to: 'OCCLUDED', cause: 'NOT_SEEN', occludedBy: u.occludedBy, at: t });
        }
      }
    }

    // ---- 3. new items: stable count above the units we already have (7.1 row 1)
    for (const [cls, n] of stable) {
      const product = catalog.get(cls);
      if (!product) continue;
      const eff = n - (flipUsed.get(cls) ?? 0);
      while (eff > countActive(cls)) {
        const d = [...free].filter((x) => x.class_name === cls).sort((a, b) => (trackHist.get(b.local_track_id)?.length ?? 0) - (trackHist.get(a.local_track_id)?.length ?? 0))[0];
        // a new item needs a box of its class that no unit claimed in this frame; a count that only lingers in
        // the window (flicker, or a unit just re-classified by a flip correction) is not a new item
        if (!d) break;
        // seen again right after a REMOVE without coming in from the edge: the REMOVE was wrong
        const wrong = units.filter((u) => u.state === 'REMOVED' && u.className === cls && u.removeKey && t - u.removedAt <= o.correctionMs)
          .sort((a, b) => b.removedAt - a.removedAt)[0];
        if (wrong && !(d && entryEvidence(d, roi, band))) {
          wrong.state = 'IN_CART';
          actions.push({ kind: 'correction', unit: wrong, at: t, qtyBefore: qtyOf(wrong.productId) - 1, qtyAfter: qtyOf(wrong.productId) });
          if (d) { free.delete(d); see(wrong, d, t, roi, actions); }
          continue;
        }
        const u = newUnit(product.product_id, cls, t);
        if (d) { free.delete(d); see(u, d, t, roi, actions); }
        actions.push({ kind: 'add', unit: u, at: t, entry: d ? entryEvidence(d, roi, band) : null,
          qtyBefore: qtyOf(u.productId) - 1, qtyAfter: qtyOf(u.productId) });
      }
    }
    return { actions };
  }

  /** Checkout: what is still in the cart (OCCLUDED units are still paid for). */
  function finalize(t) {
    const actions = [];
    for (const u of units.filter(active)) actions.push({ kind: 'checkout', unit: u, at: t, wasOccluded: u.state === 'OCCLUDED' });
    return { actions };
  }

  return {
    step, finalize, units,
    items: () => {
      const m = new Map();
      for (const u of units.filter(active)) {
        const e = m.get(u.productId) ?? { product_id: u.productId, class_name: u.className, qty: 0, occluded: 0, boxes: [] };
        e.qty++;
        if (u.state === 'OCCLUDED') { e.occluded++; if (u.lastBox) e.boxes.push(u.lastBox); }
        m.set(u.productId, e);
      }
      return [...m.values()];
    },
    get frame() { return frame; },
    isInRoi: (box, roi) => pointInPolygon(center(box), roi),
  };
}
