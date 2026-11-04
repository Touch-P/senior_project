// Seeds reference data. Idempotent: safe to run repeatedly (also runs at server start).
// Usage: npm run db:seed
import bcrypt from 'bcrypt';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { runJob } from '../jobs/jobRuns.js';
import { logger } from '../logger.js';
import { formatParams, importProductMaster, readModelData, readProductMaster, syncModelCoverage } from './catalog.js';
import { openDb } from './connection.js';
import { migrate } from './migrate.js';

const log = logger.child({ mod: 'seed' });

export const STORE = { code: 'LPR', name_th: 'สาขาลาดพร้าว' };

/** Same polygon as camera() in web/app.js (normalized x, y). */
export const DEFAULT_ROI = [[0.20, 0.14], [0.80, 0.14], [0.96, 0.99], [0.04, 0.99]];

/** Carts A-01..A-12, B-01..B-03, C-01..C-02 — covers every cart id used in web/data.js. */
export const CART_LABELS = [
  ...Array.from({ length: 12 }, (_, i) => `A-${String(i + 1).padStart(2, '0')}`),
  'B-01', 'B-02', 'B-03', 'C-01', 'C-02',
];

const MODEL_DATA = readModelData();

/** Labels of the 20-class dataset the models were trained on (read from the model data file, not hard-coded). */
export const CLASSES = MODEL_DATA.models[0].per_class.map((c) => c.name);

/** Model that is active on a fresh database (default_active in web/models-data.js). */
export const ACTIVE_MODEL = MODEL_DATA.default_active;

/** Models of web/models-data.js; weights_path is relative to WEIGHTS_ROOT (the models/ folder). */
export const MODELS = MODEL_DATA.models;

function seedStoreAndCarts(db) {
  db.prepare('INSERT INTO stores (code, name_th) VALUES (?, ?) ON CONFLICT (code) DO NOTHING').run(STORE.code, STORE.name_th);
  const storeId = db.prepare('SELECT store_id FROM stores WHERE code = ?').pluck().get(STORE.code);
  const addCart = db.prepare(`INSERT INTO carts (store_id, label, qr_code, roi_polygon) VALUES (?, ?, ?, ?)
                              ON CONFLICT (label) DO NOTHING`);
  const addCamera = db.prepare(`INSERT INTO devices (cart_id, store_id, device_type, label)
    SELECT c.cart_id, c.store_id, 'camera', 'กล้องรถเข็น ' || c.label FROM carts c
    WHERE c.label = ? AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.cart_id = c.cart_id AND d.device_type = 'camera')`);
  let carts = 0;
  for (const label of CART_LABELS) {
    carts += addCart.run(storeId, label, `SC-CART-${label}`, JSON.stringify(DEFAULT_ROI)).changes;
    addCamera.run(label);
  }
  return carts;
}

function seedModels(db) {
  const upsert = db.prepare(`INSERT INTO model_versions (name, family, size, format, imgsz, map50_95, map50, precision, recall,
      latency_p95_ms, params, gflops, per_class, weights_path, class_names)
    VALUES (@name, @family, @size, @format, @imgsz, @map50_95, @map50, @precision, @recall,
      @latency_p95_ms, @params, @gflops, @per_class, @weights_path, @class_names)
    ON CONFLICT (name) DO UPDATE SET family = excluded.family, size = excluded.size, format = excluded.format,
      imgsz = excluded.imgsz, map50_95 = excluded.map50_95, map50 = excluded.map50, precision = excluded.precision,
      recall = excluded.recall, latency_p95_ms = excluded.latency_p95_ms, params = excluded.params,
      gflops = excluded.gflops, per_class = excluded.per_class, weights_path = excluded.weights_path,
      class_names = COALESCE(model_versions.class_names, excluded.class_names)`);
  for (const m of MODELS) {
    upsert.run({
      ...m, imgsz: m.imgsz ?? 640, params: formatParams(m.params), per_class: JSON.stringify(m.per_class),
      class_names: JSON.stringify(m.per_class.map((c) => c.name)),
    });
  }
  // Models that are no longer in the data file leave the database.
  // Rows that sessions/frames still point at stay for those foreign keys but lose their weights and active flag;
  // the model page lists only models that have weights.
  const keep = MODELS.map((m) => m.name);
  const stale = `name NOT IN (${keep.map(() => '?').join(',')})`;
  db.prepare(`DELETE FROM model_versions WHERE ${stale}
    AND model_id NOT IN (SELECT model_id FROM shopping_sessions WHERE model_id IS NOT NULL)
    AND model_id NOT IN (SELECT DISTINCT model_id FROM frames WHERE model_id IS NOT NULL)`).run(...keep);
  db.prepare(`UPDATE model_versions SET weights_path = NULL, is_active = 0 WHERE ${stale}`).run(...keep);
  // Activate the default model only on a fresh database (or when the active one was retired above);
  // never override an admin's later choice.
  const hasActive = db.prepare('SELECT 1 FROM model_versions WHERE is_active = 1').get();
  if (!hasActive) {
    db.prepare("UPDATE model_versions SET is_active = 1, activated_at = CURRENT_TIMESTAMP WHERE name = ?").run(ACTIVE_MODEL);
  }
  return db.prepare('SELECT name, class_names FROM model_versions WHERE is_active = 1').get();
}

async function seedUsers(db) {
  const accounts = [{ email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD, name: 'สมชาย ใจดี', initials: 'สจ', role: 'admin' }];
  if (config.NODE_ENV === 'development') {
    accounts.push({ email: 'staff@smartcart.co.th', password: config.DEV_STAFF_PASSWORD, name: 'วิภา ร้านดี', initials: 'วร', role: 'staff' });
  }
  if (config.NODE_ENV === 'production' && config.ADMIN_PASSWORD === 'change-me') {
    throw new Error('Set ADMIN_PASSWORD in .env before seeding a production database');
  }
  const exists = db.prepare('SELECT 1 FROM admin_users WHERE email = ?');
  const insert = db.prepare(`INSERT INTO admin_users (email, password_hash, display_name, initials, role)
                             VALUES (?, ?, ?, ?, ?)`);
  let created = 0;
  for (const a of accounts) {
    if (exists.get(a.email)) continue; // never reset an existing password
    insert.run(a.email, await bcrypt.hash(a.password, 12), a.name, a.initials, a.role);
    created++;
  }
  return created;
}

/** Ask the inference service for model.names; null when it is not running. */
async function fetchModelNames() {
  if (config.INFERENCE_MODE !== 'real') return null;
  try {
    const res = await fetch(new URL('/health', config.INFERENCE_URL), { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = await res.json();
    const names = Array.isArray(body.names) ? body.names : Object.values(body.names ?? {});
    return names.length ? { model: body.model, names: names.map(String) } : null;
  } catch {
    return null;
  }
}

/**
 * Run all seed steps against an open database (migrations must already be applied).
 * @param {import('better-sqlite3').Database} db
 * @param {{ masterFile?: string, probeInference?: boolean }} [opts]
 */
export async function seed(db, opts = {}) {
  return runJob(db, 'seed', async () => {
    const master = readProductMaster(opts.masterFile);
    const products = importProductMaster(db, master);
    const carts = seedStoreAndCarts(db);
    const active = seedModels(db);
    const users = await seedUsers(db);

    // labels from the running service count only when it serves the active model (otherwise the server
    // start-up sync, services/models.js syncActiveModel, loads the active model first)
    const probed = opts.probeInference === false ? null : await fetchModelNames();
    const live = probed?.model === active.name ? probed.names : null;
    const names = live ?? JSON.parse(active.class_names);
    if (live) {
      db.prepare('UPDATE model_versions SET class_names = ? WHERE is_active = 1').run(JSON.stringify(live));
    }
    const coverage = syncModelCoverage(db, names);
    if (coverage.missingInProducts.length) {
      log.warn({ missing: coverage.missingInProducts }, 'model labels not found in products — add them to products_master.csv');
    }
    const summary = { products, carts, users, model: active.name, classSource: live ? 'inference /health' : 'model_versions', detectable: coverage.detectable };
    log.info(summary, 'seed finished');
    return { ...summary, rows: products.inserted + products.updated + products.prices + carts + users, message: JSON.stringify(summary) };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  try {
    migrate(db);
    await seed(db);
  } finally {
    db.close();
  }
}
