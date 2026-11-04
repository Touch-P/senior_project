// Real-time pipeline (brief section 5): ingest -> queue -> inference -> post-process -> tracker -> cart model
// -> persist -> publish. One object per frame (`job`) collects the timestamps of every stage.
//
// Only carts with an active session are tracked and written to the database. Without a session a frame is
// inferred only when an admin is watching that cart (preview for setting the ROI), and nothing is stored.
import { setTimeout as sleep } from 'node:timers/promises';
import { createFrameStore } from './frameStore.js';
import { parseRoi } from './geometry.js';
import { frameSize } from './jpeg.js';
import { createSimpleCartModel } from './cartModel.js';
import { createPresenceModel } from './presenceModel.js';
import { statements, writeFrame } from './persist.js';
import { postprocess } from './postprocess.js';
import { createTracker } from './tracker.js';
import { createWriter } from './writer.js';
import { percentile } from '../routes/admin.js';
import { raiseAlert } from '../services/alerts.js';
import { cartSnapshot } from '../services/cart.js';

/**
 * @typedef {{ cart: string, cartId: number, deviceId: number, seq: number, header: Record<string, any>, jpeg: Buffer,
 *             tReceivedMs: number, ws?: import('ws').WebSocket }} IncomingFrame
 */

/**
 * @param {{ db: import('better-sqlite3').Database, hub: any, inference: any, log: import('pino').Logger, cfg: any,
 *           createCartModel?: Function }} deps
 */
export function createPipeline({ db, hub, inference, log, cfg, createCartModel }) {
  // PRESENCE_RULES=false: plain count changes (baseline for RQ4 mode (a)); default: presence + reasons (brief section 7)
  createCartModel ??= cfg.PRESENCE_RULES === false ? createSimpleCartModel : createPresenceModel;
  const s = statements(db);
  const writer = createWriter(db, { flushMs: cfg.WRITER_FLUSH_MS ?? 1000, maxOps: 200, log });
  const store = createFrameStore({ dir: cfg.framesDir, root: cfg.ROOT, size: 20 });
  const queueMax = cfg.FRAME_QUEUE_MAX ?? 2;
  const concurrency = cfg.INFER_CONCURRENCY ?? 1;
  const liveMs = cfg.LIVE_THROTTLE_MS ?? 250;
  const unknownLogged = new Set();

  /** per cart label */
  const carts = new Map();
  const cartState = (f) => {
    let c = carts.get(f.cart);
    if (!c) {
      c = { label: f.cart, cartId: f.cartId, queue: [], session: null, lastFrameMs: 0, lastLiveMs: 0, lastWatchMs: 0,
        disconnectedAlerted: false, recent: [], latencies: [], latencyAlertMs: 0, device: null };
      carts.set(f.cart, c);
    }
    return c;
  };

  const stats = { received: 0, processed: 0, dropped: 0, errors: 0, consecutiveErrors: 0, inferenceDownAlerted: false };
  let active = 0;
  let stopped = false;

  /** Keep the session object of a cart in step with the database (new session = new tracker + cart model). */
  function syncSession(c) {
    const row = s.activeSession.get(c.cartId);
    if (!row) {
      if (c.session) { c.session.model.close?.(); c.session = null; store.clear(c.label); }
      return null;
    }
    if (c.session?.id !== row.session_id) {
      const cart = s.cart.get(c.cartId);
      c.session = {
        id: row.session_id,
        startedAt: row.started_at_ms,
        tracker: createTracker({ mode: cfg.TRACKER_MODE, window: cfg.TRACKER_WINDOW, addK: cfg.TRACKER_ADD_K, refFps: cfg.TRACKER_REF_FPS }),
        model: createCartModel({ db, writer, hub, store, cfg, log, sessionId: row.session_id, cart }),
      };
      store.clear(c.label);
      c.disconnectedAlerted = false;
      inference.resetTracks(c.label).catch(() => {}); // ByteTrack IDs start fresh per session
    }
    return c.session;
  }

  // ------------------------------------------------------------------ ingest (stage 2)
  /** @param {IncomingFrame} f */
  function onFrame(f) {
    if (stopped) return;
    stats.received++;
    const c = cartState(f);
    c.lastFrameMs = f.tReceivedMs;
    c.device = f.ws ?? c.device;
    c.disconnectedAlerted = false;
    // real size of the picture (from the JPEG, the header only as fallback): boxes are normalised to it and the
    // Live view uses it as the aspect ratio, so a portrait 3:4 frame is never shown or stored as 4:3
    const size = frameSize(f.jpeg, f.header);
    // newest frame in memory for the Live grid thumbnail (hub.setLatest: replaced every frame, never written to disk)
    hub.setLatest?.(f.cart, { seq: f.seq, jpeg: f.jpeg, t: f.tReceivedMs, w: size.w, h: size.h });
    const session = syncSession(c);
    if (!session && !hub.isWatched?.(f.cart)) {
      // idle camera (no customer session, nobody watching): nothing is inferred or stored
      sendDevice(c, { type: 'processed', seq: f.seq, idle: true, t_server: Date.now() });
      publishIdle(c, f);
      return;
    }
    const job = { ...f, size, sessionId: session?.id ?? null, t: { received: f.tReceivedMs } };
    c.queue.push(job);
    if (c.queue.length > queueMax) dropJob(c, c.queue.shift());
    pump();
  }

  function dropJob(c, job) {
    stats.dropped++;
    if (!job.sessionId) return;
    writer.enqueue((d) => writeFrame(d, frameRow(c, job, { dropped: 1 }), []));
  }

  // ------------------------------------------------------------------ worker (stage 3)
  function nextJob() {
    let best = null;
    for (const c of carts.values()) {
      const j = c.queue[0];
      if (j && (!best || j.t.received < best.job.t.received)) best = { c, job: j };
    }
    if (best) best.c.queue.shift();
    return best;
  }

  function pump() {
    while (!stopped && active < concurrency) {
      const next = nextJob();
      if (!next) return;
      active++;
      process(next.c, next.job)
        .catch((err) => log.error({ err, cart: next.c.label }, 'pipeline frame failed'))
        .finally(() => { active--; pump(); });
    }
  }

  async function process(c, job) {
    job.t.inferStart = Date.now();
    let result;
    try {
      result = await inference.infer({ cart: c.label, seq: job.seq, jpeg: job.jpeg, track: cfg.TRACKER_MODE === 'bytetrack' });
      job.t.inferEnd = result.t_infer_end_ms ?? Date.now();
      job.t.inferStart = result.t_infer_start_ms ?? job.t.inferStart;
      stats.consecutiveErrors = 0;
      if (stats.inferenceDownAlerted) {
        stats.inferenceDownAlerted = false;
        hub.toAdmins({ type: 'inference_status', ok: true });
      }
    } catch (err) {
      job.t.inferEnd = Date.now();
      stats.errors++;
      stats.consecutiveErrors++;
      job.error = err.code ?? 'INFERENCE_ERROR';
      onInferenceError(c, job, err);
      if (job.sessionId) writer.enqueue((d) => writeFrame(d, frameRow(c, job), []));
      sendDevice(c, { type: 'processed', seq: job.seq, error: job.error, t_server: Date.now() });
      return;
    }
    stats.processed++;

    // stage 4: post-process
    const cart = s.cart.get(c.cartId);
    const roi = parseRoi(cart.roi_polygon);
    const model = s.activeModel.get();
    const catalog = new Map(s.catalog.all().map((p) => [p.class_name, p]));
    const dets = postprocess(result.detections, {
      catalog, roi, confThreshold: model?.conf_threshold ?? cfg.CONF_THRESHOLD,
      onUnknown: (name) => { if (!unknownLogged.has(name)) { unknownLogged.add(name); log.warn({ class_name: name }, 'model label not in products; skipped'); } },
    });
    job.modelId = (result.model && s.modelByName.pluck().get(result.model)) ?? model?.model_id ?? null;
    job.result = result;
    job.dets = dets;

    const session = c.session?.id === job.sessionId ? c.session : null;
    let snapshot = null;
    if (session) {
      // stage 5: tracker
      // the receive time drives the tracker's frame-rate scale (W / K are frames at TRACKER_REF_FPS)
      // + the phone's declared fps (hello) until the real rate of this cart is measured
      const tr = session.tracker.update(dets, job.t.received, job.ws?.settings?.fps);
      job.t.tracker = Date.now();
      job.tracker = tr;
      store.push(c.label, { seq: job.seq, jpeg: job.jpeg, frameId: null, sessionId: session.id, t: job.t.received, job });
      // stages 6-7: cart model decides events; frames with events are written at once (they are referenced)
      const out = session.model.update({ job, tracker: tr, dets, catalog, roi });
      if (out.events.length) {
        job.frameId = writer.now((d) => {
          const id = writeFrame(d, frameRow(c, job), dets);
          out.persist(d, id);
          return id;
        });
        const path = store.save(session.id, job.seq, job.jpeg, job.t.received);
        writer.enqueue(() => s.frameImage.run(path, job.frameId));
      }
      job.t.db = Date.now();
      // stage 8: publish
      if (out.events.length || out.changed) {
        snapshot = cartSnapshot(db, session.id, { state: tr.state, frameSeq: job.seq });
        hub.toDisplay(session.id, snapshot);
        for (const e of out.messages ?? []) hub.toAdmins(e);
      }
    } else {
      job.t.tracker = job.t.db = Date.now();
    }
    publishLive(c, job, snapshot, roi);
    job.t.pushed = Date.now();
    sendDevice(c, { type: 'processed', seq: job.seq, detections: dets.filter((d) => d.accepted).length,
      state: job.tracker?.state ?? null, t_server: job.t.pushed });

    if (session) {
      if (job.frameId) writer.enqueue(() => s.frameTimes.run(job.t.db, job.t.pushed, job.frameId));
      else writer.enqueue((d) => { job.frameId = writeFrame(d, frameRow(c, job), dets); });
      trackLatency(c, job);
    }
  }

  function frameRow(c, job, { dropped = 0 } = {}) {
    const h = job.header ?? {};
    return {
      session_id: job.sessionId, cart_id: c.cartId, model_id: job.modelId ?? null, seq: job.seq,
      width: job.size?.w ?? job.result?.w ?? null, height: job.size?.h ?? job.result?.h ?? null,
      jpeg_bytes: job.jpeg?.length ?? null,
      t_capture_device_ms: Number.isFinite(h.t_capture) ? h.t_capture : null, // device clock: never subtracted from server times
      t_received_ms: job.t.received,
      t_infer_start_ms: dropped ? null : job.t.inferStart ?? null,
      t_infer_end_ms: dropped ? null : job.t.inferEnd ?? null,
      infer_ms: job.result?.infer_ms ?? null,
      t_tracker_ms: job.t.tracker ?? null, t_db_ms: job.t.db ?? null, t_pushed_ms: job.t.pushed ?? null,
      dropped, error: job.error ?? null, image_path: null,
      num_detections: job.dets ? job.dets.length : null,
    };
  }

  function sendDevice(c, msg) {
    const ws = c.device;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  const countFrame = (c, now) => {
    c.recent.push(now);
    while (c.recent.length && now - c.recent[0] > 5000) c.recent.shift();
  };
  const liveFps = (c) => Math.round((c.recent.length / 5) * 10) / 10;

  // idle camera: no inference, but the Live grid still gets a throttled "new frame" signal (seq) and loads
  // GET /api/admin/carts/:label/latest.jpg itself; items are empty because no customer session runs
  function publishIdle(c, f) {
    const now = Date.now();
    countFrame(c, now);
    if (now - c.lastLiveMs < liveMs) return;
    c.lastLiveMs = now;
    hub.toAdmins({ type: 'live_update', event: 'frame', cart: c.label, session_id: null, idle: true, seq: f.seq,
      state: null, fps: liveFps(c), detections: null, server_ms: now - f.tReceivedMs, infer_ms: null,
      items: [], total: 0, item_count: 0, t: now, t_server_sent: now });
  }

  // admin dashboard: throttled summary for everyone, the JPEG + boxes only for admins watching this cart
  function publishLive(c, job, snapshot, roi) {
    const now = Date.now();
    countFrame(c, now);
    if (hub.isWatched?.(c.label) && now - c.lastWatchMs >= liveMs) {
      c.lastWatchMs = now;
      const header = JSON.stringify({ type: 'frame', cart: c.label, seq: job.seq, session_id: job.sessionId, roi,
        w: job.size?.w ?? job.result?.w ?? null, h: job.size?.h ?? job.result?.h ?? null,
        detections: job.dets.map((d) => ({ class_name: d.class_name, conf: d.conf, box: d.box, in_roi: d.in_roi,
          accepted: d.accepted, track_id: d.local_track_id ?? null })),
        t_server: now });
      hub.toWatchers(c.label, Buffer.concat([Buffer.from(header + '\n'), job.jpeg]));
    }
    if (!snapshot && now - c.lastLiveMs < liveMs) return;
    c.lastLiveMs = now;
    const snap = snapshot ?? (job.sessionId ? cartSnapshot(db, job.sessionId, { state: job.tracker?.state, frameSeq: job.seq }) : null);
    hub.toAdmins({
      type: 'live_update', event: 'frame', cart: c.label, session_id: job.sessionId, seq: job.seq,
      state: job.tracker?.state ?? null, fps: liveFps(c), tracker_scale: job.tracker?.scale ?? null,
      detections: job.dets.filter((d) => d.accepted).length,
      server_ms: now - job.t.received, infer_ms: job.result?.infer_ms ?? null,
      items: snap?.items.map((i) => ({ class_name: i.class_name, name: i.name, qty: i.qty, subtotal: i.subtotal })) ?? [],
      total: snap?.total ?? 0, item_count: snap?.item_count ?? 0, t: now, t_server_sent: now,
    });
  }

  // ------------------------------------------------------------------ alerts
  function onInferenceError(c, job, err) {
    if (stats.consecutiveErrors >= (cfg.INFERENCE_DOWN_AFTER ?? 5) && !stats.inferenceDownAlerted) {
      stats.inferenceDownAlerted = true;
      raiseAlert(db, hub, { type: 'INFERENCE_DOWN', cartId: c.cartId, sessionId: job.sessionId,
        message: `inference ไม่ตอบ ${stats.consecutiveErrors} เฟรมติดกัน (${err.code})`, payload: { error: err.message } });
      hub.toAdmins({ type: 'inference_status', ok: false, error: err.code });
    }
  }

  function trackLatency(c, job) {
    c.latencies.push(job.t.pushed - job.t.received);
    if (c.latencies.length > 100) c.latencies.shift();
    const limit = cfg.HIGH_LATENCY_MS ?? 300;
    if (c.latencies.length < 20 || Date.now() - c.latencyAlertMs < 5 * 60_000) return;
    const p95 = percentile(c.latencies, 95);
    if (p95 > limit) {
      c.latencyAlertMs = Date.now();
      raiseAlert(db, hub, { type: 'HIGH_LATENCY', cartId: c.cartId, sessionId: job.sessionId,
        message: `${c.label} · server p95 ${Math.round(p95)} ms > ${limit} ms`, payload: { p95_ms: p95 } });
    }
  }

  // camera silent during an active session -> DISCONNECTED (once until frames come back)
  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const c of carts.values()) {
      if (!c.session || c.disconnectedAlerted || !c.lastFrameMs) continue;
      if (now - c.lastFrameMs > (cfg.DISCONNECT_MS ?? 30_000)) {
        c.disconnectedAlerted = true;
        if (!s.activeSession.get(c.cartId)) continue;
        raiseAlert(db, hub, { type: 'DISCONNECTED', cartId: c.cartId, sessionId: c.session.id,
          message: `${c.label} · ไม่มีเฟรมจากกล้อง ${Math.round((now - c.lastFrameMs) / 1000)} วินาที` });
      }
    }
  }, 5000);
  watchdog.unref();
  // reasons whose pairing window closed become final even when no frame arrives (camera off, cart parked)
  const ticker = setInterval(() => {
    for (const c of carts.values()) {
      try { c.session?.model.tick?.(Date.now()); } catch (err) { log.error({ err, cart: c.label }, 'reason tick failed'); }
    }
  }, 1000);
  ticker.unref();

  // customer pressed "รายการไม่ถูกต้อง": keep the recent frames of that cart as evidence (retrain export)
  hub.events?.on('feedback', ({ cart, sessionId, feedbackId }) => {
    if (!store.recent(cart).some((r) => r.sessionId === sessionId)) return;
    writer.flush(); // batched frame rows get their frame_id here
    const ring = store.recent(cart).filter((r) => r.sessionId === sessionId && r.job.frameId);
    // the last ~5 s, thinned to ~20 files (30 fps would otherwise write 150 near-identical JPEGs per report)
    for (const r of store.evidence(ring)) {
      const frameId = r.job.frameId;
      if (!frameId) continue;
      const path = store.save(sessionId, r.seq, r.jpeg, r.t);
      s.frameImage.run(path, frameId);
    }
    const last = ring.findLast((r) => r.job.frameId);
    if (last) s.feedbackFrame.run(last.job.frameId, feedbackId);
  });
  hub.events?.on('session_closing', ({ sessionId, cartId }) => {
    for (const c of carts.values()) if (c.cartId === cartId && c.session?.id === sessionId) c.session.model.finalize?.();
    writer.flush();
  });

  return {
    onFrame,
    /** device metrics (device clock only): rtt_ms = send -> ack, e2e_ms = send -> processed */
    recordMetrics(cartId, items) {
      writer.flush();
      let n = 0;
      for (const m of items) n += s.touchFrameMetrics.run({ cart_id: cartId, seq: m.seq, rtt_ms: m.rtt_ms ?? null, e2e_ms: m.e2e_ms ?? null }).changes;
      return n;
    },
    stats: () => ({ ...stats, active, queued: [...carts.values()].reduce((n, c) => n + c.queue.length, 0), writer: writer.stats() }),
    async drain(timeoutMs = 5000) {
      const end = Date.now() + timeoutMs;
      while ((active || [...carts.values()].some((c) => c.queue.length)) && Date.now() < end) await sleep(10);
      writer.flush();
    },
    stop() { stopped = true; clearInterval(watchdog); clearInterval(ticker); writer.close(); },
  };
}
