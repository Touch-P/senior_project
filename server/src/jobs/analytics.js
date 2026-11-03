// Nightly analytics (brief section 5): daily_product_stats, daily_cooccurrence (lift computed here in Node.js)
// and daily_change_reasons for one local day and store. A day is deleted and rebuilt, so the job is idempotent.
import { runJob } from './jobRuns.js';
import { dayBounds, localDay } from './time.js';

/**
 * Rebuild the summaries of `day` for every store.
 * @param {import('better-sqlite3').Database} db
 * @param {string} day YYYY-MM-DD (local)
 * @returns {{ products: number, pairs: number, reasons: number }}
 */
export function computeDay(db, day) {
  const now = Date.now();
  let products = 0, pairs = 0, reasons = 0;
  const stores = db.prepare('SELECT store_id, timezone FROM stores').all();
  db.transaction(() => {
    for (const { store_id: storeId, timezone } of stores) {
      const [from, to] = dayBounds(day, timezone);
      for (const t of ['daily_product_stats', 'daily_cooccurrence', 'daily_change_reasons']) {
        db.prepare(`DELETE FROM ${t} WHERE day = ? AND store_id = ?`).run(day, storeId);
      }
      // sessions of this store that started on that day
      const inDay = `SELECT s.session_id FROM shopping_sessions s JOIN carts c USING (cart_id)
                     WHERE c.store_id = @storeId AND s.started_at_ms >= @from AND s.started_at_ms < @to`;
      const args = { storeId, from, to };

      // ---- products: automatic ADD/REMOVE, purchased units and revenue of checked-out baskets
      const ev = db.prepare(`SELECT product_id,
          SUM(CASE WHEN event_type = 'ADD' THEN qty_delta ELSE 0 END) AS added,
          SUM(CASE WHEN event_type = 'REMOVE' THEN -qty_delta ELSE 0 END) AS removed,
          COUNT(DISTINCT session_id) AS sessions
        FROM cart_events WHERE source = 'auto' AND event_type IN ('ADD','REMOVE') AND product_id IS NOT NULL
          AND session_id IN (${inDay}) GROUP BY product_id`).all(args);
      const bought = db.prepare(`SELECT h.product_id, SUM(h.qty) AS purchased, SUM(h.qty * COALESCE(h.unit_price, 0)) AS revenue
        FROM cart_item_history h JOIN shopping_sessions s USING (session_id)
        WHERE h.is_current = 1 AND h.qty > 0 AND s.status = 'checked_out' AND h.session_id IN (${inDay}) GROUP BY h.product_id`).all(args);
      const byId = new Map();
      for (const e of ev) byId.set(e.product_id, { added: e.added, removed: e.removed, sessions: e.sessions, purchased: 0, revenue: 0 });
      for (const b of bought) byId.set(b.product_id, { added: 0, removed: 0, sessions: 0, ...byId.get(b.product_id), purchased: b.purchased, revenue: b.revenue });
      const insP = db.prepare(`INSERT INTO daily_product_stats (day, store_id, product_id, added, removed, purchased, revenue, sessions, abandon_rate, computed_at_ms)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const [pid, x] of byId) {
        insP.run(day, storeId, pid, x.added, x.removed, x.purchased, Math.round(x.revenue * 100) / 100, x.sessions,
          x.added ? Math.round((x.removed / x.added) * 10000) / 10000 : null, now);
        products++;
      }

      // ---- co-occurrence of products in the same checked-out basket
      const baskets = new Map();
      for (const r of db.prepare(`SELECT h.session_id, h.product_id FROM cart_item_history h JOIN shopping_sessions s USING (session_id)
          WHERE h.is_current = 1 AND h.qty > 0 AND s.status = 'checked_out' AND h.session_id IN (${inDay})`).all(args)) {
        if (!baskets.has(r.session_id)) baskets.set(r.session_id, new Set());
        baskets.get(r.session_id).add(r.product_id);
      }
      const N = baskets.size;
      if (N) {
        const single = new Map(), pair = new Map();
        for (const items of baskets.values()) {
          const ids = [...items].sort((a, b) => a - b);
          for (const a of ids) single.set(a, (single.get(a) ?? 0) + 1);
          for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
            const k = `${ids[i]}:${ids[j]}`;
            pair.set(k, (pair.get(k) ?? 0) + 1);
          }
        }
        const insC = db.prepare(`INSERT INTO daily_cooccurrence (day, store_id, product_a, product_b, sessions_together, baskets, support, confidence_ab, lift, computed_at_ms)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const [k, n] of pair) {
          const [a, b] = k.split(':').map(Number);
          const support = n / N, sa = single.get(a) / N, sb = single.get(b) / N;
          insC.run(day, storeId, a, b, n, N, round4(support), round4(n / single.get(a)), round4(support / (sa * sb)), now);
          pairs++;
        }
      }

      // ---- change reasons decided that day
      const rs = db.prepare(`SELECT reason_code, COUNT(*) AS n, AVG(dwell_ms) AS avg_dwell_ms, AVG(price_delta) AS avg_price_delta
        FROM change_reasons WHERE status = 'final' AND session_id IN (${inDay}) GROUP BY reason_code`).all(args);
      const insR = db.prepare(`INSERT INTO daily_change_reasons (day, store_id, reason_code, n, avg_dwell_ms, avg_price_delta, computed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const r of rs) { insR.run(day, storeId, r.reason_code, r.n, r.avg_dwell_ms, r.avg_price_delta, now); reasons++; }
    }
  })();
  return { products, pairs, reasons };
}

const round4 = (v) => Math.round(v * 10000) / 10000;

/**
 * Job entry: summarise `day` (default: yesterday and today) and log to job_runs.
 * @param {{ day?: string, days?: string[], tz?: string }} [opts]
 */
export function runAnalytics(db, opts = {}) {
  const tz = opts.tz ?? db.prepare('SELECT timezone FROM stores ORDER BY store_id LIMIT 1').pluck().get() ?? 'Asia/Bangkok';
  const now = Date.now();
  const days = opts.days ?? (opts.day ? [opts.day] : [localDay(now - 86_400_000, tz), localDay(now, tz)]);
  return runJob(db, 'analytics', () => {
    const totals = { products: 0, pairs: 0, reasons: 0 };
    for (const d of [...new Set(days)]) {
      const r = computeDay(db, d);
      for (const k of Object.keys(totals)) totals[k] += r[k];
    }
    return { ...totals, days, rows: totals.products + totals.pairs + totals.reasons, message: JSON.stringify({ days, ...totals }) };
  });
}
