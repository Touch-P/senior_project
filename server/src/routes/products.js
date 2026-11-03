// /api/admin/products — search, scan and edit products (brief section 8). Admin only: staff gets 403 on every
// route (registered through r.admin, so the role test covers new routes automatically).
import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../http/errors.js';
import { bindBarcode, createProduct, getProduct, promoteDuePrices, searchProducts, setPrice, updateProduct } from '../services/products.js';
import { routes } from './registry.js';

const BASE = '/api/admin/products';
const Via = z.enum(['search_name', 'search_barcode', 'scan_camera', 'table']).optional();
const Barcode = z.string().regex(/^\d{8,14}$/, 'บาร์โค้ดต้องเป็นตัวเลข 8–14 หลัก');
const Money = z.number().positive().max(100_000);
const text = (max = 100) => z.string().trim().min(1).max(max);
const opt = (s) => s.nullable().optional();

const PriceBody = z.object({
  price: Money,
  promo_price: opt(Money),
  valid_from_ms: opt(z.number().int().positive()),
  via: Via,
}).strict().refine((b) => b.promo_price == null || b.promo_price < b.price, { message: 'ราคาโปรต้องต่ำกว่าราคาปกติ', path: ['promo_price'] });

const PatchBody = z.object({
  class_name: z.string().regex(/^[A-Za-z0-9_]{2,60}$/, 'class_name ใช้ a-z, 0-9, _').optional(),
  sku: opt(text(40)),
  name_th: text(120).optional(),
  name_en: opt(text(120)),
  brand: opt(text(60)),
  product_line: opt(text(60)),
  flavor: opt(text(60)),
  variant: opt(text(60)),
  size_desc: opt(text(40)),
  category: opt(text(60)),
  sub_category: opt(text(60)),
  weight_g: opt(z.number().positive().max(100_000)),
  is_active: z.boolean().optional(),
  via: Via,
}).strict();

const CreateBody = PatchBody.extend({
  class_name: z.string().regex(/^[A-Za-z0-9_]{2,60}$/, 'class_name ใช้ a-z, 0-9, _'),
  name_th: text(120),
  barcode: opt(Barcode),
  price: Money,
  promo_price: opt(Money),
}).strict().refine((b) => b.promo_price == null || b.promo_price < b.price, { message: 'ราคาโปรต้องต่ำกว่าราคาปกติ', path: ['promo_price'] });

const Id = z.coerce.number().int().positive();

export function productRoutes({ db, hub }) {
  const router = Router();
  const r = routes(router, BASE);
  const changed = (product, action) => {
    hub.toAdmins({ type: 'products_changed', product_id: product.product_id, class_name: product.class_name, action });
    return product;
  };

  r.admin('get', '/search', (req, res) => {
    const q = parse(z.object({ q: z.string().max(100).optional(), barcode: z.string().max(20).optional() }), req.query);
    res.json(searchProducts(db, q));
  });

  r.admin('get', '/:id', (req, res) => {
    promoteDuePrices(db);
    res.json(getProduct(db, parse(Id, req.params.id)));
  });

  r.admin('patch', '/:id', (req, res) => {
    const { via, ...patch } = parse(PatchBody, req.body);
    res.json(changed(updateProduct(db, parse(Id, req.params.id), patch, req.user, via), 'UPDATE'));
  });

  r.admin('post', '/:id/prices', (req, res) => {
    const { via, ...price } = parse(PriceBody, req.body);
    promoteDuePrices(db);
    res.status(201).json(changed(setPrice(db, parse(Id, req.params.id), price, req.user, via), 'PRICE'));
  });

  r.admin('post', '/:id/barcode', (req, res) => {
    const { barcode, via } = parse(z.object({ barcode: Barcode, via: Via }).strict(), req.body);
    res.json(changed(bindBarcode(db, parse(Id, req.params.id), barcode, req.user, via), 'BIND_BARCODE'));
  });

  r.admin('post', '/', (req, res) => {
    const { via, ...body } = parse(CreateBody, req.body);
    res.status(201).json(changed(createProduct(db, body, req.user, via), 'CREATE'));
  });

  return router;
}
