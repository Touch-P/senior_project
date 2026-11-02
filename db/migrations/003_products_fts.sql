-- 003_products_fts.sql — full-text product search for Thai names (no spaces between words)
-- requires: fts5_trigram
-- The migration runner skips this file when the bundled SQLite lacks the trigram
-- tokenizer (< 3.34); product search then falls back to LIKE.

CREATE VIRTUAL TABLE products_fts USING fts5(
  name_th, brand, class_name, sku,
  content='products', content_rowid='product_id', tokenize='trigram'
);

CREATE TRIGGER products_fts_ai AFTER INSERT ON products BEGIN
  INSERT INTO products_fts (rowid, name_th, brand, class_name, sku)
  VALUES (new.product_id, new.name_th, new.brand, new.class_name, new.sku);
END;

CREATE TRIGGER products_fts_ad AFTER DELETE ON products BEGIN
  INSERT INTO products_fts (products_fts, rowid, name_th, brand, class_name, sku)
  VALUES ('delete', old.product_id, old.name_th, old.brand, old.class_name, old.sku);
END;

CREATE TRIGGER products_fts_au AFTER UPDATE OF name_th, brand, class_name, sku ON products BEGIN
  INSERT INTO products_fts (products_fts, rowid, name_th, brand, class_name, sku)
  VALUES ('delete', old.product_id, old.name_th, old.brand, old.class_name, old.sku);
  INSERT INTO products_fts (rowid, name_th, brand, class_name, sku)
  VALUES (new.product_id, new.name_th, new.brand, new.class_name, new.sku);
END;

INSERT INTO products_fts (products_fts) VALUES ('rebuild');
