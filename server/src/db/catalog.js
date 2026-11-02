// Product master import and model-coverage sync (shared by seed and server start).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

const MASTER_COLUMNS = ['class_name', 'sku', 'barcode', 'name_th', 'brand', 'product_line', 'flavor', 'variant',
  'size_desc', 'category', 'sub_category', 'price', 'promo_price', 'in_model'];

/**
 * Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF/LF).
 * @param {string} text
 * @returns {Record<string, string>[]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((v) => v !== '')) rows.push(row); }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

/**
 * Read and validate db/seed/products_master.csv.
 * @param {string} [file]
 */
export function readProductMaster(file = join(config.seedDir, 'products_master.csv')) {
  const rows = parseCsv(readFileSync(file, 'utf8'));
  const missingCols = MASTER_COLUMNS.filter((c) => !(c in (rows[0] ?? {})));
  if (missingCols.length) throw new Error(`products_master.csv is missing columns: ${missingCols.join(', ')}`);
  const seen = new Set();
  return rows.map((r, i) => {
    const line = i + 2;
    if (!r.class_name || !r.name_th) throw new Error(`products_master.csv line ${line}: class_name and name_th are required`);
    if (seen.has(r.class_name)) throw new Error(`products_master.csv line ${line}: duplicate class_name ${r.class_name}`);
    seen.add(r.class_name);
    if (r.barcode && !/^\d{8,14}$/.test(r.barcode)) throw new Error(`products_master.csv line ${line}: barcode must be 8-14 digits`);
    const price = Number(r.price), promo = r.promo_price === '' ? null : Number(r.promo_price);
    if (!(price > 0)) throw new Error(`products_master.csv line ${line}: price must be > 0`);
    if (promo != null && !(promo > 0 && promo < price)) throw new Error(`products_master.csv line ${line}: promo_price must be < price`);
    const nul = (v) => (v === '' ? null : v);
    return {
      class_name: r.class_name, sku: nul(r.sku), barcode: nul(r.barcode), name_th: r.name_th, brand: nul(r.brand),
      product_line: nul(r.product_line), flavor: nul(r.flavor), variant: nul(r.variant), size_desc: nul(r.size_desc),
      category: nul(r.category), sub_category: nul(r.sub_category), price, promo_price: promo,
      in_model: r.in_model === '1' ? 1 : 0,
    };
  });
}

/**
 * Upsert products and their current price from the master file.
 * Products or prices that an admin has edited (product_audit rows / prices with created_by)
 * are left untouched so a re-seed or server restart never reverts manual changes.
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<typeof readProductMaster>} master
 * @param {number} [atMs] valid_from for new price rows
 */
export function importProductMaster(db, master, atMs = Date.now()) {
  const stats = { inserted: 0, updated: 0, prices: 0, keptManual: 0 };
  const find = db.prepare('SELECT product_id FROM products WHERE class_name = ?');
  const edited = db.prepare('SELECT 1 FROM product_audit WHERE product_id = ? LIMIT 1');
  const insert = db.prepare(`INSERT INTO products (class_name, sku, barcode, name_th, brand, product_line, flavor, variant,
      size_desc, category, sub_category, image_path, in_model)
    VALUES (@class_name, @sku, @barcode, @name_th, @brand, @product_line, @flavor, @variant,
      @size_desc, @category, @sub_category, @image_path, @in_model)`);
  const update = db.prepare(`UPDATE products SET sku = @sku, barcode = COALESCE(@barcode, barcode), name_th = @name_th,
      brand = @brand, product_line = @product_line, flavor = @flavor, variant = @variant, size_desc = @size_desc,
      category = @category, sub_category = @sub_category, image_path = COALESCE(image_path, @image_path)
    WHERE product_id = @product_id AND (sku IS NOT @sku OR name_th IS NOT @name_th OR brand IS NOT @brand
      OR product_line IS NOT @product_line OR flavor IS NOT @flavor OR variant IS NOT @variant
      OR size_desc IS NOT @size_desc OR category IS NOT @category OR sub_category IS NOT @sub_category
      OR (@barcode IS NOT NULL AND barcode IS NOT @barcode) OR (image_path IS NULL AND @image_path IS NOT NULL))`);
  const currentPrice = db.prepare('SELECT price_id, price, promo_price, created_by FROM product_prices WHERE product_id = ? AND is_current = 1');
  const closePrice = db.prepare('UPDATE product_prices SET valid_to_ms = ?, is_current = 0 WHERE price_id = ?');
  const openPrice = db.prepare('INSERT INTO product_prices (product_id, price, promo_price, valid_from_ms) VALUES (?, ?, ?, ?)');

  db.transaction(() => {
    for (const p of master) {
      const img = `assets/products/${p.class_name}.jpg`;
      const row = { ...p, image_path: existsSync(join(config.webDir, img)) ? img : null };
      let id = find.get(p.class_name)?.product_id;
      if (id == null) {
        id = Number(insert.run(row).lastInsertRowid);
        stats.inserted++;
      } else if (edited.get(id)) {
        stats.keptManual++;
      } else if (update.run({ ...row, product_id: id }).changes) {
        stats.updated++;
      }
      const cur = currentPrice.get(id);
      if (!cur) {
        openPrice.run(id, p.price, p.promo_price, atMs);
        stats.prices++;
      } else if (cur.created_by == null && (cur.price !== p.price || cur.promo_price !== p.promo_price)) {
        closePrice.run(atMs, cur.price_id);
        openPrice.run(id, p.price, p.promo_price, atMs);
        stats.prices++;
      }
    }
  })();
  return stats;
}

/**
 * Mark which products the active model can detect (products.in_model) from its class names,
 * so swapping weights for a 20-class model needs no code change.
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} classNames model.names of the active model
 * @returns {{ detectable: number, missingInProducts: string[] }}
 */
export function syncModelCoverage(db, classNames) {
  const names = [...new Set(classNames)];
  const known = new Set(db.prepare('SELECT class_name FROM products').pluck().all());
  db.transaction(() => {
    db.prepare('UPDATE products SET in_model = 0 WHERE in_model = 1').run();
    const mark = db.prepare('UPDATE products SET in_model = 1 WHERE class_name = ?');
    for (const n of names) mark.run(n);
  })();
  return { detectable: names.filter((n) => known.has(n)).length, missingInProducts: names.filter((n) => !known.has(n)) };
}
