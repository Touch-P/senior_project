// Read-only product list for any logged-in role (staff can view the "สินค้าและราคา" table).
// Editing, search and barcode routes are admin-only under /api/admin/products (Phase 7).
import { Router } from 'express';

export function catalogRoutes({ db }) {
  const r = Router();
  r.get('/', (req, res) => {
    const products = db.prepare(`SELECT p.product_id, p.class_name, p.sku, p.barcode, p.name_th, p.brand, p.product_line,
        p.flavor, p.variant, p.size_desc, p.category, p.sub_category, p.weight_g, p.image_path, p.is_active, p.in_model,
        pp.price, pp.promo_price, pp.valid_from_ms
      FROM products p
      LEFT JOIN product_prices pp ON pp.product_id = p.product_id AND pp.is_current = 1 AND pp.store_id IS NULL
      ORDER BY p.in_model DESC, p.class_name`).all()
      .map((p) => ({ ...p, is_active: Boolean(p.is_active), in_model: Boolean(p.in_model) }));
    res.json({ products, counts: { total: products.length, in_model: products.filter((p) => p.in_model).length } });
  });
  return r;
}
