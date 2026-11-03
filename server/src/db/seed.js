// Seeds reference data. Idempotent: safe to run repeatedly (also runs at server start).
// Usage: npm run db:seed
import bcrypt from 'bcrypt';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { runJob } from '../jobs/jobRuns.js';
import { logger } from '../logger.js';
import { importProductMaster, readProductMaster, syncModelCoverage } from './catalog.js';
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

/** Labels of the 11-class dataset every benchmark model was trained on (SNP/experiment.yaml). */
export const CLASSES_11 = ['bengbeng_pack12', 'doritos_mid_nacho', 'koalas_march_chocolate', 'kohkae_small_wasabi',
  'lay_big_nori', 'lay_big_ori', 'lay_party_ori', 'mama_cup_ok_cheeseGo', 'mama_cup_ok_hotKR',
  'pringles_norm_ori', 'rosdee_mid_pork'];

export const ACTIVE_MODEL = 'yolo11s-s0-20261025';

/** MODELS from web/data.js + weights paths relative to WEIGHTS_ROOT (SNP, read-only). */
export const MODELS = [
  ['yolo11s-s0-20261025', 'YOLO11', 's', 'pt', 0.916, 4.20, '9.43M', 21.7, 'yolov11/outputv11/yolo11s-s0-20261025/weights/best.pt'],
  ['yolo12s-s0-20261025', 'YOLO12', 's', 'pt', 0.916, 5.81, '9.26M', 23.5, 'yolov12/outputv12/yolo12s-s0-20261025/weights/best.pt'],
  ['yolov10s-s0-20261025', 'YOLOv10', 's', 'pt', 0.913, 4.63, '8.07M', 24.9, 'yolov10/outputv10/yolov10s-s0-20261025/weights/best.pt'],
  ['yolov13s-s0-20261025', 'YOLOv13', 's', 'pt', 0.911, 8.79, '9.56M', 21.7, 'yolov13/outputv13/yolov13s-s0-20261025/weights/best.pt'],
  ['yolov8s-s0-20261025', 'YOLOv8', 's', 'pt', 0.894, 3.45, '11.14M', 28.7, 'yolov8/outputv8/yolov8s-s0-20261025/weights/best.pt'],
  ['yolo26s-s0-20261025', 'YOLO26', 's', 'pt', 0.894, 5.56, '9.96M', 22.8, 'yolov26/outputv26/yolo26s-s0-20261025/weights/best.pt'],
  ['yolov5su-s0-20261025', 'YOLOv5', 'su', 'pt', 0.885, 4.20, '9.13M', 24.1, 'yolov5/outputv5/yolov5su-s0-20261025/weights/best.pt'],
  ['yolov6s-s0-20261025', 'YOLOv6', 's', 'pt', 0.868, 4.15, '20.10M', null, 'yolov6/outputv6/yolov6s-s0-20261025/weights/best_ckpt.pt'],
  ['yolov7-tiny-s0-20261025', 'YOLOv7', 'tiny', 'pt', 0.767, 3.62, '6.03M', null, 'yolov7/outputv7/yolov7-tiny-s0-20261025/weights/best.pt'],
  ['yolov4-s0-20261025', 'YOLOv4', '—', 'weights', 0.280, 6.44, '—', null, 'yolov4/outputv4/yolov4-s0-20261025/weights/yolov4-smartcart_best.weights'],
];

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
  const upsert = db.prepare(`INSERT INTO model_versions (name, family, size, format, map50_95, latency_p95_ms, params, gflops,
      weights_path, class_names)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET family = excluded.family, size = excluded.size, format = excluded.format,
      map50_95 = excluded.map50_95, latency_p95_ms = excluded.latency_p95_ms, params = excluded.params,
      gflops = excluded.gflops, weights_path = excluded.weights_path,
      class_names = COALESCE(model_versions.class_names, excluded.class_names)`);
  for (const m of MODELS) upsert.run(...m, JSON.stringify(CLASSES_11));
  // Activate the default model only on a fresh database; never override an admin's later choice.
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
