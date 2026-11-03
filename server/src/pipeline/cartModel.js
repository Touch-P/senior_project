// Stage 6: turn tracker output into cart events.
// Phase 5 model: a change of the stable count of a class is an ADD / REMOVE of that many items.
// Phase 6 replaces it with the presence engine (occlusion, exit evidence, model flip, reasons) — same interface:
//   update({ job, tracker, dets, catalog, roi }) -> { events, changed, persist(db, frameId), messages }
//   finalize()  session is closing (checkout)      close()  session object discarded
import { applyItemChange } from './persist.js';

export function createSimpleCartModel({ sessionId, cart }) {
  return {
    update({ job, tracker, dets, catalog }) {
      const events = [];
      for (const ch of tracker.changes) {
        const product = catalog.get(ch.class_name);
        if (!product) continue;
        const confs = dets.filter((d) => d.accepted && d.class_name === ch.class_name).map((d) => d.conf);
        events.push({
          productId: product.product_id, className: ch.class_name, delta: ch.to - ch.from,
          confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
        });
      }
      const messages = [];
      return {
        events,
        changed: events.length > 0,
        messages,
        persist(db, frameId) {
          for (const e of events) {
            const r = applyItemChange(db, { sessionId, storeId: cart.store_id, productId: e.productId, delta: e.delta,
              frameId, confidence: e.confidence, at: job.t.received });
            messages.push({ type: 'cart_event', cart: cart.label, session_id: sessionId, event_id: r.event_id,
              event_type: e.delta > 0 ? 'ADD' : 'REMOVE', class_name: e.className, qty_delta: r.qty_after - r.qty_before,
              qty_after: r.qty_after, unit_price: r.unit_price, frame_seq: job.seq, t: job.t.received });
          }
        },
      };
    },
    finalize() {},
    close() {},
  };
}
