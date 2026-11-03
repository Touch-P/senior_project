// Active model: the database (model_versions.is_active) is the source of truth; the inference service follows it.
import { isAbsolute, resolve } from 'node:path';
import { config } from '../config.js';
import { syncModelCoverage } from '../db/catalog.js';
import { HttpError } from '../http/errors.js';

/** model_versions.weights_path is relative to WEIGHTS_ROOT (the read-only benchmark folder). */
export const weightsPath = (rel) => (isAbsolute(rel) ? rel : resolve(config.WEIGHTS_ROOT, rel));

const activeRow = (db) => db.prepare('SELECT model_id, name, weights_path, class_names FROM model_versions WHERE is_active = 1').get();

/** Map an InferenceError to the API error the admin UI shows. */
function toHttpError(err) {
  if (err.code === 'INFERENCE_REJECTED') {
    const reason = err.body?.error ?? 'MODEL_LOAD_FAILED';
    const text = {
      MODEL_LOAD_FAILED: 'inference โหลด weights นี้ไม่ได้ (รุ่นนี้ต้องใช้ repo ของตัวเอง ไม่ใช่ Ultralytics)',
      UNSUPPORTED_FORMAT: 'รูปแบบ weights นี้ inference ยังไม่รองรับ (รองรับ .pt / .engine / .onnx)',
      WEIGHTS_NOT_FOUND: 'ไม่พบไฟล์ weights ของโมเดลนี้',
      PATH_NOT_ALLOWED: 'weights อยู่นอกโฟลเดอร์ WEIGHTS_ROOT',
    }[reason] ?? 'inference ไม่ยอมโหลดโมเดลนี้';
    return new HttpError(422, reason === 'MODEL_LOAD_FAILED' ? reason : `MODEL_${reason}`, text, { detail: err.message });
  }
  return new HttpError(503, 'INFERENCE_DOWN', 'เชื่อมต่อ inference service ไม่ได้ จึงยังไม่เปลี่ยนโมเดล', { detail: err.message });
}

/** Store the label list of the loaded weights and refresh products.in_model. */
function applyNames(db, modelId, names) {
  if (!names?.length) return null;
  db.prepare('UPDATE model_versions SET class_names = ? WHERE model_id = ?').run(JSON.stringify(names), modelId);
  return syncModelCoverage(db, names);
}

let switching = false;

/** Model switches are logged in job_runs (job = 'model_switch') for the history on the model page. */
function logSwitch(db, status, info) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO job_runs (job, started_at, finished_at, status, message) VALUES (?, ?, ?, ?, ?)')
    .run('model_switch', ts, ts, status, JSON.stringify(info));
}

export function switchHistory(db, limit = 10) {
  return db.prepare("SELECT started_at, status, message FROM job_runs WHERE job = 'model_switch' ORDER BY run_id DESC LIMIT ?").all(limit)
    .map((r) => ({ at: r.started_at, status: r.status, ...JSON.parse(r.message ?? '{}') }));
}

/**
 * Switch the active model. Real mode loads the weights first; the database changes only if loading succeeded,
 * so a model the service cannot run never becomes active.
 * @param {{ db: import('better-sqlite3').Database, hub: any, inference: any, log?: import('pino').Logger }} deps
 * @param {string} name
 * @param {{ display_name: string }} user
 */
export async function activateModel({ db, hub, inference, log }, name, user) {
  const target = db.prepare('SELECT model_id, name, weights_path, class_names FROM model_versions WHERE name = ?').get(name);
  if (!target) throw new HttpError(404, 'MODEL_NOT_FOUND', 'ไม่พบโมเดล');
  if (switching) throw new HttpError(409, 'MODEL_SWITCH_IN_PROGRESS', 'กำลังเปลี่ยนโมเดลอยู่ รอสักครู่');
  switching = true;
  try {
    const from = activeRow(db)?.name ?? null;
    const t0 = Date.now();
    let names = target.class_names ? JSON.parse(target.class_names) : null;
    if (inference.mode === 'real') {
      if (!target.weights_path) throw new HttpError(422, 'MODEL_NO_WEIGHTS', 'โมเดลนี้ไม่มี weights_path');
      try {
        const loaded = await inference.loadModel({ name: target.name, path: weightsPath(target.weights_path) });
        names = loaded.names ?? names;
      } catch (err) {
        log?.warn({ model: name, err: err.message }, 'model switch failed; keeping the current model');
        const httpErr = toHttpError(err);
        logSwitch(db, 'error', { from, to: name, by: user.display_name, error: httpErr.code, switch_ms: Date.now() - t0 });
        throw httpErr;
      }
    }
    const coverage = db.transaction(() => {
      db.prepare('UPDATE model_versions SET is_active = 0 WHERE is_active = 1').run();
      db.prepare('UPDATE model_versions SET is_active = 1, activated_at = CURRENT_TIMESTAMP WHERE model_id = ?').run(target.model_id);
      return applyNames(db, target.model_id, names);
    })();
    const switchMs = Date.now() - t0;
    logSwitch(db, 'ok', { from, to: name, by: user.display_name, switch_ms: switchMs });
    hub.toAdmins({ type: 'model_changed', from, to: name, by: user.display_name, switch_ms: switchMs });
    log?.info({ from, to: name, switch_ms: switchMs, by: user.display_name }, 'model activated');
    return { from, to: name, switch_ms: switchMs, detectable: coverage?.detectable ?? null };
  } finally {
    switching = false;
  }
}

/**
 * Make the inference service serve the model that is active in the database, and take the class names from
 * the weights actually loaded (so 20-class weights work without code changes). Safe to call repeatedly.
 * @returns {Promise<{ ok: boolean, model?: string, loaded?: boolean, error?: string }>}
 */
export async function syncActiveModel({ db, inference, log }) {
  const active = activeRow(db);
  let health;
  try {
    health = await inference.health();
  } catch (err) {
    log?.warn({ err: err.message }, 'inference service not reachable — start it with "npm run inference" (or set INFERENCE_MODE=mock)');
    return { ok: false, error: err.code };
  }
  if (inference.mode === 'mock' || !active) return { ok: true, model: health.model, loaded: false };

  let names = health.names, loaded = false;
  if (health.model !== active.name) {
    try {
      const r = await inference.loadModel({ name: active.name, path: weightsPath(active.weights_path) });
      names = r.names;
      loaded = true;
      log?.info({ from: health.model, to: active.name }, 'inference switched to the model active in the database');
    } catch (err) {
      log?.error({ active: active.name, serving: health.model, err: err.message },
        'inference could not load the active model; it keeps serving another model — activate a model it can load');
      return { ok: false, model: health.model, error: err.code };
    }
  }
  const coverage = applyNames(db, active.model_id, names);
  if (coverage?.missingInProducts.length) {
    log?.warn({ missing: coverage.missingInProducts }, 'model labels not found in products — add them to products_master.csv');
  }
  return { ok: true, model: active.name, loaded };
}

/**
 * Poll the inference service; on every down -> up transition re-sync the model, and tell the dashboard.
 * (INFERENCE_DOWN alerts from failed frames are raised by the pipeline in Phase 5.)
 */
export function watchInference({ db, hub, inference, log }, intervalMs = 15_000) {
  if (inference.mode === 'mock') return { stop() {} };
  let up = inference.status().ok === true;
  const tick = async () => {
    let now = false;
    try { await inference.health(); now = true; } catch { now = false; }
    if (now && !up) await syncActiveModel({ db, inference, log });
    if (now !== up) {
      log?.[now ? 'info' : 'warn']('inference service is ' + (now ? 'up' : 'down'));
      hub.toAdmins({ type: 'inference_status', ok: now, ...pick(inference.status()) });
    }
    up = now;
  };
  const timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/** Public subset of the client status (no stack traces). */
export function pick(s) {
  return { mode: s.mode, ok: s.ok, model: s.model, device: s.device, nc: s.names?.length ?? 0,
    checked_at_ms: s.checked_at_ms, last_error: s.last_error };
}
