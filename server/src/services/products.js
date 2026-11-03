// Product search and editing for admins (brief section 8). Every change writes product_audit with the channel
// it came from (via: search_name / search_barcode / scan_camera / table).
import { supportsTrigram } from '../db/connection.js';
import { syncModelCoverage } from '../db/catalog.js';
import { HttpError } from '../http/errors.js';

/** trim, lower case, no spaces — Thai names have no spaces between words, users type them anyway */
export const normalize = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '');

export const isBarcodeLike = (s) => /^(\d{8}|\d{12}|\d{13})$/.test(s);

/** GS1 check digit for EAN-8, UPC-A (12) and EAN-13. */
export function barcodeChecksumOk(code) {
  if (!isBarcodeLike(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop();
  // weights 3,1,3,1… from the right of the payload
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

const SELECT = `SELECT p.product_id, p.class_name, p.sku, p.barcode, p.name_th, p.name_en, p.brand, p.product_line, p.flavor,
    p.variant, p.size_desc, p.category, p.sub_category, p.weight_g, p.image_path, p.is_active, p.in_model, p.updated_at,
    pp.price, pp.promo_price, pp.valid_from_ms
  FROM products p LEFT JOIN product_prices pp ON pp.product_id = p.product_id AND pp.is_current = 1 AND pp.store_id IS NULL`;
const shape = (p) => p && ({ ...p, is_active: Boolean(p.is_active), in_model: Boolean(p.in_model) });

/**
 * Search order (brief 8): 8/12/13 digits -> exact barcode first (checksum warning when wrong);
 * otherwise / not found -> FTS5 trigram (>= 3 characters) over name_th, brand, class_name, sku; shorter
 * queries or no trigram support -> LIKE on normalised text. Ranked exact > starts with > contains, max 20.
 * @param {import('better-sqlite3').Database} db
 * @param {{ q?: string, barcode?: string }} input
 */
export function searchProducts(db, { q = '', barcode = '' }) {
  const text = String(q).trim();
  const code = String(barcode || (isBarcodeLike(text) ? text : '')).trim();
  if (code) {
    const checksum_ok = barcodeChecksumOk(code);
    const hit = shape(db.prepare(`${SELECT} WHERE p.barcode = ?`).get(code));
    return {
      mode: 'barcode', query: code, checksum_ok,
      warning: checksum_ok ? null : 'เลขตรวจสอบของบาร์โค้ดไม่ถูกต้อง อาจสแกนหรือพิมพ์ผิด',
      barcode_not_found: !hit, results: hit ? [hit] : [],
    };
  }
  const norm = normalize(text);
  if (!norm) return { mode: 'all', query: '', results: db.prepare(`${SELECT} ORDER BY p.in_model DESC, p.class_name LIMIT 20`).all().map(shape) };

  let rows, mode;
  if (norm.length >= 3 && supportsTrigram(db)) {
    mode = 'fts';
    // trigram FTS matches substrings; quote the phrase so FTS syntax characters are literal
    const phrase = `"${text.replace(/"/g, '""')}"`;
    rows = db.prepare(`${SELECT} WHERE p.product_id IN (SELECT rowid FROM products_fts WHERE products_fts MATCH ?)`).all(phrase);
    if (!rows.length && norm !== text.toLowerCase()) rows = db.prepare(`${SELECT} WHERE p.product_id IN (SELECT rowid FROM products_fts WHERE products_fts MATCH ?)`).all(`"${norm.replace(/"/g, '""')}"`);
  }
  if (!rows?.length) {
    mode = mode === 'fts' ? 'fts+like' : 'like';
    const like = `%${norm.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const col = (c) => `REPLACE(LOWER(COALESCE(${c}, '')), ' ', '') LIKE ? ESCAPE '\\'`;
    rows = db.prepare(`${SELECT} WHERE ${['p.name_th', 'p.name_en', 'p.brand', 'p.class_name', 'p.sku'].map(col).join(' OR ')}`)
      .all(like, like, like, like, like);
  }
  const fields = (p) => [p.name_th, p.name_en, p.brand, p.class_name, p.sku].map(normalize);
  const rank = (p) => {
    const f = fields(p);
    if (f.includes(norm)) return 0;
    if (f.some((v) => v.startsWith(norm))) return 1;
    return 2;
  };
  rows.sort((a, b) => rank(a) - rank(b) || b.in_model - a.in_model || a.class_name.localeCompare(b.class_name));
  return { mode, query: text, results: rows.slice(0, 20).map(shape) };
}

export function getProduct(db, productId) {
  const p = shape(db.prepare(`${SELECT} WHERE p.product_id = ?`).get(productId));
  if (!p) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'ไม่พบสินค้า');
  const prices = db.prepare(`SELECT price_id, price, promo_price, valid_from_ms, valid_to_ms, is_current, created_by, u.display_name AS created_by_name
      FROM product_prices LEFT JOIN admin_users u ON u.user_id = created_by
      WHERE product_id = ? AND store_id IS NULL ORDER BY valid_from_ms DESC, price_id DESC`).all(productId)
    .map((r) => ({ ...r, is_current: Boolean(r.is_current) }));
  const audit = db.prepare(`SELECT a.action, a.field, a.old_value, a.new_value, a.via, a.created_at, u.display_name AS by_name
      FROM product_audit a JOIN admin_users u USING (user_id) WHERE a.product_id = ? ORDER BY a.audit_id DESC LIMIT 30`).all(productId);
  return { ...p, prices, audit };
}

const audit = (db, productId, userId, action, field, oldValue, newValue, via) =>
  db.prepare(`INSERT INTO product_audit (product_id, user_id, action, field, old_value, new_value, via) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(productId, userId, action, field, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), via ?? null);

const EDITABLE = ['class_name', 'sku', 'name_th', 'name_en', 'brand', 'product_line', 'flavor', 'variant', 'size_desc', 'category', 'sub_category', 'weight_g', 'is_active'];

/** Edit product fields; class_name is locked while the active model detects the product (it must match a label). */
export function updateProduct(db, productId, patch, user, via) {
  const cur = db.prepare('SELECT * FROM products WHERE product_id = ?').get(productId);
  if (!cur) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'ไม่พบสินค้า');
  if (patch.class_name !== undefined && patch.class_name !== cur.class_name) {
    if (cur.in_model) throw new HttpError(409, 'CLASS_NAME_LOCKED', 'แก้ class_name ไม่ได้ เพราะต้องตรงกับ label ของโมเดลที่ใช้อยู่');
    if (db.prepare('SELECT 1 FROM products WHERE class_name = ? AND product_id != ?').get(patch.class_name, productId)) {
      throw new HttpError(409, 'CLASS_NAME_TAKEN', 'class_name นี้มีสินค้าอื่นใช้แล้ว');
    }
  }
  const changes = [];
  for (const k of EDITABLE) {
    if (patch[k] === undefined) continue;
    const next = k === 'is_active' ? (patch[k] ? 1 : 0) : patch[k];
    if (next === cur[k]) continue;
    changes.push([k, cur[k], next]);
  }
  if (!changes.length) return getProduct(db, productId);
  db.transaction(() => {
    const sets = changes.map(([k]) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE products SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE product_id = @id`)
      .run({ id: productId, ...Object.fromEntries(changes.map(([k, , v]) => [k, v])) });
    for (const [k, oldV, newV] of changes) {
      audit(db, productId, user.user_id, k === 'is_active' && !newV ? 'DEACTIVATE' : 'UPDATE', k, oldV, newV, via);
    }
    if (changes.some(([k]) => k === 'class_name')) {
      const names = db.prepare('SELECT class_names FROM model_versions WHERE is_active = 1').pluck().get();
      if (names) syncModelCoverage(db, JSON.parse(names));
    }
  })();
  return getProduct(db, productId);
}

/** Future-dated prices wait with is_current = 0; this makes the ones that are due current (SCD2). */
export function promoteDuePrices(db, now = Date.now()) {
  const due = db.prepare(`SELECT price_id, product_id, store_id, valid_from_ms FROM product_prices
                          WHERE is_current = 0 AND valid_to_ms IS NULL AND valid_from_ms <= ? ORDER BY valid_from_ms`).all(now);
  if (!due.length) return 0;
  db.transaction(() => {
    for (const p of due) {
      db.prepare(`UPDATE product_prices SET is_current = 0, valid_to_ms = ? WHERE product_id = ? AND is_current = 1
                  AND COALESCE(store_id, 0) = COALESCE(?, 0)`).run(p.valid_from_ms, p.product_id, p.store_id);
      db.prepare('UPDATE product_prices SET is_current = 1 WHERE price_id = ?').run(p.price_id);
    }
  })();
  return due.length;
}

/**
 * New price (SCD2): closes the current row at valid_from and opens a new one. Items already in a cart keep the
 * price they were added at (cart_events.unit_price snapshot). A future valid_from is stored and promoted later.
 */
export function setPrice(db, productId, { price, promo_price = null, valid_from_ms = null }, user, via) {
  const exists = db.prepare('SELECT 1 FROM products WHERE product_id = ?').get(productId);
  if (!exists) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'ไม่พบสินค้า');
  const now = Date.now();
  const from = valid_from_ms ?? now;
  const cur = db.prepare('SELECT price_id, price, promo_price, valid_from_ms FROM product_prices WHERE product_id = ? AND is_current = 1 AND store_id IS NULL').get(productId);
  if (cur && from <= cur.valid_from_ms) throw new HttpError(400, 'VALID_FROM_TOO_EARLY', 'วันที่มีผลต้องหลังจากราคาปัจจุบันเริ่มใช้');
  db.transaction(() => {
    // replace a not-yet-active future price instead of stacking several
    db.prepare('DELETE FROM product_prices WHERE product_id = ? AND store_id IS NULL AND is_current = 0 AND valid_to_ms IS NULL AND valid_from_ms > ?').run(productId, now);
    if (from <= now) {
      if (cur) db.prepare('UPDATE product_prices SET is_current = 0, valid_to_ms = ? WHERE price_id = ?').run(from, cur.price_id);
      db.prepare(`INSERT INTO product_prices (product_id, price, promo_price, valid_from_ms, is_current, created_by) VALUES (?, ?, ?, ?, 1, ?)`)
        .run(productId, price, promo_price, from, user.user_id);
    } else {
      db.prepare(`INSERT INTO product_prices (product_id, price, promo_price, valid_from_ms, is_current, created_by) VALUES (?, ?, ?, ?, 0, ?)`)
        .run(productId, price, promo_price, from, user.user_id);
    }
    audit(db, productId, user.user_id, 'PRICE', 'price', cur ? `${cur.price}/${cur.promo_price ?? '-'}` : null, `${price}/${promo_price ?? '-'} @${new Date(from).toISOString()}`, via);
    db.prepare('UPDATE products SET updated_at = CURRENT_TIMESTAMP WHERE product_id = ?').run(productId);
  })();
  return getProduct(db, productId);
}

/** Bind a barcode to a product; a barcode owned by another product is a 409 with that product. */
export function bindBarcode(db, productId, barcode, user, via) {
  const cur = db.prepare('SELECT product_id, barcode FROM products WHERE product_id = ?').get(productId);
  if (!cur) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'ไม่พบสินค้า');
  const owner = db.prepare('SELECT product_id, class_name, name_th FROM products WHERE barcode = ? AND product_id != ?').get(barcode, productId);
  if (owner) throw new HttpError(409, 'BARCODE_TAKEN', `บาร์โค้ดนี้ผูกกับ ${owner.name_th} อยู่แล้ว`, { product: owner });
  if (cur.barcode !== barcode) {
    db.transaction(() => {
      db.prepare('UPDATE products SET barcode = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ?').run(barcode, productId);
      audit(db, productId, user.user_id, 'BIND_BARCODE', 'barcode', cur.barcode, barcode, via);
    })();
  }
  return { ...getProduct(db, productId), checksum_ok: barcodeChecksumOk(barcode) };
}

/** New product (e.g. a barcode that was not found). in_model follows the active model's labels (usually 0). */
export function createProduct(db, body, user, via) {
  if (db.prepare('SELECT 1 FROM products WHERE class_name = ?').get(body.class_name)) {
    throw new HttpError(409, 'CLASS_NAME_TAKEN', 'class_name นี้มีอยู่แล้ว');
  }
  if (body.barcode && db.prepare('SELECT 1 FROM products WHERE barcode = ?').get(body.barcode)) {
    throw new HttpError(409, 'BARCODE_TAKEN', 'บาร์โค้ดนี้ผูกกับสินค้าอื่นอยู่แล้ว');
  }
  const id = db.transaction(() => {
    const cols = ['class_name', 'sku', 'barcode', 'name_th', 'name_en', 'brand', 'product_line', 'flavor', 'variant', 'size_desc', 'category', 'sub_category', 'weight_g'];
    const pid = Number(db.prepare(`INSERT INTO products (${cols.join(', ')}, in_model, updated_at) VALUES (${cols.map((c) => '@' + c).join(', ')}, 0, CURRENT_TIMESTAMP)`)
      .run(Object.fromEntries(cols.map((c) => [c, body[c] ?? null]))).lastInsertRowid);
    db.prepare(`INSERT INTO product_prices (product_id, price, promo_price, valid_from_ms, is_current, created_by) VALUES (?, ?, ?, ?, 1, ?)`)
      .run(pid, body.price, body.promo_price ?? null, Date.now(), user.user_id);
    audit(db, pid, user.user_id, 'CREATE', null, null, body.class_name, via);
    const names = db.prepare('SELECT class_names FROM model_versions WHERE is_active = 1').pluck().get();
    if (names) syncModelCoverage(db, JSON.parse(names));
    return pid;
  })();
  return getProduct(db, id);
}
