// Inference client with one interface for both modes:
//   real: HTTP to the Python service (inference/app.py)
//   mock: replays server/test/scenarios/*.json per cart, no Python or GPU needed (demo fallback, tests)
//
// interface Inference {
//   mode: 'real' | 'mock'
//   health(): Promise<Health>                       // model name, names, device
//   infer({ cart, seq, jpeg, track }): Promise<InferResult>
//   loadModel({ name, path }): Promise<{ model, names|null, load_ms }>
//   resetTracks(cart): Promise<boolean>             // new session: forget ByteTrack state / restart scenario
//   status(): Status                                 // last known state, no I/O
// }
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { loadScenarios } from './scenarios.js';

export class InferenceError extends Error {
  /**
   * @param {'INFERENCE_DOWN'|'INFERENCE_TIMEOUT'|'INFERENCE_BAD_RESPONSE'|'INFERENCE_REJECTED'} code
   * @param {string} message
   * @param {{ status?: number, body?: unknown }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'InferenceError';
    this.code = code;
    this.status = extra.status;
    this.body = extra.body;
  }
}

const Names = z.union([z.array(z.string()), z.record(z.string(), z.string()).transform((r) => Object.keys(r).sort((a, b) => a - b).map((k) => r[k]))]);
const HealthSchema = z.object({
  status: z.string(),
  model: z.string().nullable(),
  names: Names,
  device: z.string(),
}).passthrough();
const DetectionSchema = z.object({
  class_name: z.string(),
  class_id: z.number().int().optional(),
  conf: z.number().min(0).max(1),
  x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
  track_id: z.number().int().nullable().optional(),
});
const InferSchema = z.object({
  detections: z.array(DetectionSchema),
  model: z.string(),
  infer_ms: z.number(),
}).passthrough();
const LoadSchema = z.object({ model: z.string(), names: Names, load_ms: z.number().optional() }).passthrough();

/**
 * @typedef {z.infer<typeof DetectionSchema>} Detection
 * @typedef {{ detections: Detection[], model: string, infer_ms: number, t_infer_start_ms: number, t_infer_end_ms: number, [k: string]: unknown }} InferResult
 */

function newStatus(mode) {
  return { mode, ok: null, model: null, device: null, names: [], checked_at_ms: null, last_error: null, consecutive_errors: 0 };
}

/**
 * @param {{ url: string, timeoutMs: number, healthTimeoutMs?: number, loadTimeoutMs?: number }} opts
 */
export function createRealInference({ url, timeoutMs, healthTimeoutMs = 1500, loadTimeoutMs = 120_000 }) {
  const state = newStatus('real');

  async function call(path, { method = 'GET', body, headers, query, timeout = timeoutMs } = {}) {
    const u = new URL(path, url);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    let res;
    try {
      res = await fetch(u, { method, body, headers, signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      if (err.name === 'TimeoutError') throw new InferenceError('INFERENCE_TIMEOUT', `inference did not answer within ${timeout} ms`);
      throw new InferenceError('INFERENCE_DOWN', `cannot reach inference at ${url} (${err.cause?.code ?? err.message})`);
    }
    let json;
    try { json = await res.json(); } catch {
      throw new InferenceError('INFERENCE_BAD_RESPONSE', `inference ${path} returned non-JSON (HTTP ${res.status})`, { status: res.status });
    }
    if (!res.ok) {
      throw new InferenceError('INFERENCE_REJECTED', json?.message ?? `HTTP ${res.status}`, { status: res.status, body: json });
    }
    return json;
  }

  const validate = (schema, json, what) => {
    const r = schema.safeParse(json);
    if (!r.success) throw new InferenceError('INFERENCE_BAD_RESPONSE', `unexpected ${what} response: ${z.prettifyError(r.error)}`);
    return r.data;
  };

  const ok = (patch = {}) => Object.assign(state, { ok: true, last_error: null, consecutive_errors: 0, checked_at_ms: Date.now() }, patch);
  const fail = (err) => {
    // a rejected request (bad image, 4xx) does not mean the service is down
    if (err.code !== 'INFERENCE_REJECTED') Object.assign(state, { ok: false, consecutive_errors: state.consecutive_errors + 1 });
    Object.assign(state, { last_error: { code: err.code, message: err.message, at_ms: Date.now() }, checked_at_ms: Date.now() });
    throw err;
  };

  return {
    mode: 'real',
    async health() {
      try {
        const h = validate(HealthSchema, await call('/health', { timeout: healthTimeoutMs }), '/health');
        ok({ model: h.model, device: h.device, names: h.names });
        return h;
      } catch (err) { return fail(err); }
    },
    /** @returns {Promise<InferResult>} */
    async infer({ cart, seq, jpeg, track = false }) {
      const t0 = Date.now();
      try {
        const json = await call('/infer', {
          method: 'POST', body: jpeg, headers: { 'content-type': 'image/jpeg' },
          query: { cart_id: cart, seq, track: track ? 'true' : undefined },
        });
        const r = validate(InferSchema, json, '/infer');
        ok({ model: r.model });
        return { ...r, t_infer_start_ms: t0, t_infer_end_ms: Date.now() };
      } catch (err) { return fail(err); }
    },
    async loadModel({ name, path }) {
      try {
        const r = validate(LoadSchema, await call('/model', {
          method: 'POST', body: JSON.stringify({ name, path }), headers: { 'content-type': 'application/json' }, timeout: loadTimeoutMs,
        }), '/model');
        ok({ model: r.model, names: r.names });
        return r;
      } catch (err) { return fail(err); }
    },
    async resetTracks(cart) {
      try { return Boolean((await call(`/tracks/${encodeURIComponent(cart)}`, { method: 'DELETE' })).reset); } catch { return false; }
    },
    status: () => ({ ...state }),
  };
}

/**
 * @param {{ scenarios: ReturnType<typeof loadScenarios>, active: () => { name: string, names: string[] } | null,
 *           force?: string | null, latencyMs?: number }} opts
 */
export function createMockInference({ scenarios, active, force = null, latencyMs = 0 }) {
  if (force && !scenarios.has(force)) throw new Error(`MOCK_SCENARIO "${force}" not found (have: ${[...scenarios.keys()].join(', ')})`);
  const list = [...scenarios.values()];
  /** @type {Map<string, { name: string, i: number }>} */
  const cursors = new Map();
  const pick = (cart) => (force ? scenarios.get(force) : null)
    ?? list.find((s) => s.cart === cart) ?? list.find((s) => s.default) ?? list[0] ?? null;
  const state = newStatus('mock');

  return {
    mode: 'mock',
    async health() {
      const a = active();
      Object.assign(state, { ok: true, model: a?.name ?? null, device: 'mock', names: a?.names ?? [], checked_at_ms: Date.now() });
      return { status: 'ok', mode: 'mock', model: state.model, names: state.names, nc: state.names.length, device: 'mock',
        scenarios: list.map((s) => ({ name: s.name, cart: s.cart ?? null, frames: s.frames.length, default: s.default })) };
    },
    /** @returns {Promise<InferResult>} */
    async infer({ cart, seq, track = false }) {
      const t0 = Date.now();
      if (latencyMs > 0) await sleep(latencyMs);
      const sc = pick(cart);
      const model = active()?.name ?? 'mock';
      if (!sc) return { detections: [], model, infer_ms: 0, scenario: null, frame: null, seq, t_infer_start_ms: t0, t_infer_end_ms: Date.now() };
      let cur = cursors.get(cart);
      if (!cur || cur.name !== sc.name) cursors.set(cart, (cur = { name: sc.name, i: 0 }));
      const n = sc.frames.length;
      const idx = sc.loop ? cur.i % n : Math.min(cur.i, n - 1); // non-looping scenarios hold the last frame
      cur.i++;
      const frame = sc.frames[idx];
      const detections = frame.detections.map(({ id, track_id, ...d }) => (track ? { ...d, track_id } : d));
      return { detections, model, infer_ms: sc.infer_ms, scenario: sc.name, frame: idx, seq,
        t_infer_start_ms: t0, t_infer_end_ms: Date.now() };
    },
    async loadModel({ name }) {
      return { model: name, names: null, load_ms: 0 }; // mock keeps the class names stored in model_versions
    },
    async resetTracks(cart) { return cursors.delete(cart); },
    status: () => ({ ...state, ok: true, model: active()?.name ?? null, device: 'mock' }),
  };
}

/**
 * Build the client selected by INFERENCE_MODE.
 * @param {import('../config.js').Config} cfg
 * @param {import('better-sqlite3').Database} db
 */
export function createInference(cfg, db) {
  if (cfg.INFERENCE_MODE === 'mock') {
    const activeStmt = db.prepare('SELECT name, class_names FROM model_versions WHERE is_active = 1');
    return createMockInference({
      scenarios: loadScenarios(cfg.scenariosDir),
      force: cfg.MOCK_SCENARIO || null,
      latencyMs: cfg.MOCK_LATENCY_MS,
      active: () => {
        const row = activeStmt.get();
        return row ? { name: row.name, names: row.class_names ? JSON.parse(row.class_names) : [] } : null;
      },
    });
  }
  return createRealInference({ url: cfg.INFERENCE_URL, timeoutMs: cfg.INFERENCE_TIMEOUT_MS });
}
