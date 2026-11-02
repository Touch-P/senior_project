-- 002_presence_reasons.sql — per-unit presence tracking (SCD2), change reasons,
-- product attributes for the reason engine, product audit, device E2E latency, job log.

-- ---------------------------------------------------------------- products: attributes + model coverage
ALTER TABLE products ADD COLUMN product_line TEXT;
ALTER TABLE products ADD COLUMN flavor       TEXT;   -- taste / scent
ALTER TABLE products ADD COLUMN variant      TEXT;   -- size / pack, e.g. big, party, pack12
ALTER TABLE products ADD COLUMN sub_category TEXT;   -- used by BRAND_SWITCH (chips, sweet_snack, ...)
ALTER TABLE products ADD COLUMN in_model     INTEGER NOT NULL DEFAULT 0; -- 1 = active model can detect it
ALTER TABLE products ADD COLUMN updated_at   TEXT;
CREATE UNIQUE INDEX ux_products_barcode ON products (barcode) WHERE barcode IS NOT NULL;

-- ---------------------------------------------------------------- frames: E2E measured on the phone
ALTER TABLE frames ADD COLUMN e2e_ms REAL;

DROP VIEW v_frame_latency;
CREATE VIEW v_frame_latency AS
SELECT f.frame_id, f.session_id, f.cart_id, f.seq, f.t_received_ms,
       f.t_infer_start_ms - f.t_received_ms  AS queue_ms,
       f.t_infer_end_ms   - f.t_infer_start_ms AS infer_call_ms,
       f.infer_ms                             AS infer_model_ms,
       f.t_tracker_ms     - f.t_infer_end_ms  AS tracker_ms,
       f.t_db_ms          - f.t_tracker_ms    AS db_ms,
       f.t_pushed_ms      - f.t_db_ms         AS push_ms,
       f.t_pushed_ms      - f.t_received_ms   AS server_total_ms,
       f.e2e_ms                               AS e2e_ms        -- device clock only (send -> ack/update)
FROM frames f
WHERE f.dropped = 0 AND f.error IS NULL;

-- ---------------------------------------------------------------- new alert types
INSERT INTO alert_types (alert_type, default_severity, description_th) VALUES
  ('OCCLUDED_AT_CHECKOUT', 'warning', 'มีสินค้าที่ถูกบังอยู่ตอนชำระเงิน ให้พนักงานตรวจ'),
  ('MODEL_FLIP',           'warning', 'โมเดลสลับคลาสของสินค้าชิ้นเดิม (ไม่นับเป็นการหยิบเข้า–ออก)'),
  ('INFERENCE_DOWN',       'danger',  'inference service ไม่ตอบต่อเนื่อง');

-- ---------------------------------------------------------------- per-unit presence (SCD Type 2)
-- A state change closes the current row (valid_to_ms, is_current = 0) and opens a new one.
CREATE TABLE cart_item_presence (
  presence_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT NOT NULL REFERENCES shopping_sessions(session_id),
  product_id       INTEGER NOT NULL REFERENCES products(product_id),
  unit_no          INTEGER NOT NULL,      -- n-th unit of this product in the session
  local_track_id   INTEGER,
  state            TEXT NOT NULL CHECK (state IN ('IN_CART','OCCLUDED','REMOVED')),
  change_cause     TEXT NOT NULL CHECK (change_cause IN
                   ('ADDED','NOT_SEEN','SEEN_AGAIN','EXIT_EVIDENCE','CHECKOUT','CORRECTION')),
  occluded_by_product_id INTEGER REFERENCES products(product_id),
  last_seen_ms     INTEGER,
  last_box         TEXT,                  -- JSON [x1,y1,x2,y2] of the last sighting
  valid_from_ms    INTEGER NOT NULL,
  valid_to_ms      INTEGER,               -- NULL = current state
  is_current       INTEGER NOT NULL DEFAULT 1,
  caused_by_event_id INTEGER REFERENCES cart_events(event_id)
);
CREATE UNIQUE INDEX ux_presence_current ON cart_item_presence (session_id, product_id, unit_no) WHERE is_current = 1;
CREATE INDEX ix_presence_session ON cart_item_presence (session_id, valid_from_ms);

-- ---------------------------------------------------------------- change reasons
CREATE TABLE change_reasons (
  reason_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT NOT NULL REFERENCES shopping_sessions(session_id),
  reason_code      TEXT NOT NULL CHECK (reason_code IN
                   ('BRAND_SWITCH','FLAVOR_SWITCH','QTY_CHANGE','VARIANT_SWITCH','ABANDON')),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','final','voided')),
  from_product_id  INTEGER REFERENCES products(product_id),
  to_product_id    INTEGER REFERENCES products(product_id),
  remove_event_id  INTEGER REFERENCES cart_events(event_id),
  add_event_id     INTEGER REFERENCES cart_events(event_id),
  qty_before       INTEGER,
  qty_after        INTEGER,
  price_delta      REAL,      -- unit price to - from
  dwell_ms         INTEGER,   -- time the removed unit spent in the cart
  gap_ms           INTEGER,   -- time between the paired REMOVE and ADD
  rule_version     TEXT NOT NULL,
  evidence         TEXT,      -- JSON: matched rule, differing attributes, frame ids
  decided_at_ms    INTEGER NOT NULL
);
CREATE INDEX ix_reasons_session ON change_reasons (session_id, decided_at_ms);

CREATE VIEW v_change_reason_summary AS
SELECT reason_code, COUNT(*) AS n, ROUND(AVG(dwell_ms) / 1000.0, 1) AS avg_dwell_s,
       ROUND(AVG(price_delta), 2) AS avg_price_delta
FROM change_reasons WHERE status = 'final' GROUP BY reason_code;

-- ---------------------------------------------------------------- product audit
CREATE TABLE product_audit (
  audit_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(product_id),
  user_id     INTEGER NOT NULL REFERENCES admin_users(user_id),
  action      TEXT NOT NULL CHECK (action IN ('CREATE','UPDATE','PRICE','BIND_BARCODE','DEACTIVATE')),
  field       TEXT,
  old_value   TEXT,
  new_value   TEXT,
  via         TEXT CHECK (via IS NULL OR via IN ('search_name','search_barcode','scan_camera','table')),
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ix_audit_product ON product_audit (product_id, created_at);

-- ---------------------------------------------------------------- batch job log
CREATE TABLE job_runs (
  run_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job            TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  status         TEXT NOT NULL CHECK (status IN ('running','ok','error','skipped')),
  rows_affected  INTEGER,
  message        TEXT
);
CREATE INDEX ix_job_runs_job ON job_runs (job, started_at);
