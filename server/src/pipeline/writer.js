// Stage 7: single writer. High-volume rows (frames without events, detections) are queued and committed
// together every ~1 s or 200 operations; anything the customer will see (cart events) is written at once
// with `now()`, which first flushes the queue so rows keep their order.
/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ flushMs?: number, maxOps?: number, log?: import('pino').Logger }} [opts]
 */
export function createWriter(db, { flushMs = 1000, maxOps = 200, log } = {}) {
  /** @type {((db: import('better-sqlite3').Database) => void)[]} */
  let queue = [];
  let timer = null;
  const stats = { batches: 0, ops: 0, errors: 0 };

  const runBatch = db.transaction((ops) => { for (const op of ops) op(db); });

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length) return 0;
    const ops = queue;
    queue = [];
    try {
      runBatch(ops);
      stats.batches++;
      stats.ops += ops.length;
    } catch (err) {
      // one bad row must not lose the whole batch: retry one by one and log the failures
      stats.errors++;
      log?.error({ err: err.message, ops: ops.length }, 'writer batch failed; retrying row by row');
      for (const op of ops) {
        try { db.transaction(op)(db); stats.ops++; } catch (e) { log?.error({ err: e.message }, 'writer op dropped'); }
      }
    }
    return ops.length;
  }

  return {
    /** Queue a write; committed with the next batch. */
    enqueue(op) {
      queue.push(op);
      if (queue.length >= maxOps) flush();
      else if (!timer) { timer = setTimeout(flush, flushMs); timer.unref?.(); }
    },
    /** Flush the queue, then run `fn` in its own transaction and return its result. */
    now(fn) {
      flush();
      return db.transaction(fn)(db);
    },
    flush,
    pending: () => queue.length,
    stats: () => ({ ...stats, pending: queue.length }),
    close() { flush(); },
  };
}
