-- 001_init.sql — core Smart Cart schema
-- Conventions:
--   * *_ms columns are Unix epoch milliseconds from the SERVER clock (pipeline/event time).
--   * created_at / updated_at are TEXT 'YYYY-MM-DD HH:MM:SS' UTC (audit time).
--   * JSON is stored as TEXT.
-- PRAGMAs (WAL, foreign_keys, busy_timeout) are set per connection in server/src/db/connection.js.

-- ---------------------------------------------------------------- store / hardware
CREATE TABLE stores (
  store_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name_th     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE carts (
  cart_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id     INTEGER NOT NULL REFERENCES stores(store_id),
  label        TEXT NOT NULL UNIQUE,              -- e.g. A-07 (printed on the cart, used in URLs)
  qr_code      TEXT NOT NULL UNIQUE,              -- payload of the QR on the handle
  roi_polygon  TEXT NOT NULL,                     -- JSON [[x,y],...] normalized 0-1
  status       TEXT NOT NULL DEFAULT 'available'
               CHECK (status IN ('available','in_use','offline','maintenance')),
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT
);

CREATE TABLE devices (
  device_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_id       INTEGER REFERENCES carts(cart_id),
  device_type   TEXT NOT NULL CHECK (device_type IN ('camera','display')),
  label         TEXT,
  token_hash    TEXT UNIQUE,                      -- sha256 of the device token; NULL = not provisioned
  user_agent    TEXT,
  last_seen_ms  INTEGER,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ix_devices_cart ON devices (cart_id);

-- ---------------------------------------------------------------- catalogue
CREATE TABLE products (
  product_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  class_name  TEXT NOT NULL UNIQUE,               -- must equal the YOLO label name
  sku         TEXT UNIQUE,
  barcode     TEXT,
  name_th     TEXT NOT NULL,
  name_en     TEXT,
  brand       TEXT,
  category    TEXT,
  size_desc   TEXT,
  image_path  TEXT,                               -- relative to web/
  is_active   INTEGER NOT NULL DEFAULT 1,         -- 0 = not for sale
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- price history, SCD Type 2: a change closes the current row and opens a new one
CREATE TABLE product_prices (
  price_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id     INTEGER NOT NULL REFERENCES products(product_id),
  price          REAL NOT NULL CHECK (price > 0),
  promo_price    REAL CHECK (promo_price IS NULL OR (promo_price > 0 AND promo_price < price)),
  valid_from_ms  INTEGER NOT NULL,
  valid_to_ms    INTEGER,                         -- NULL = open-ended
  is_current     INTEGER NOT NULL DEFAULT 1,
  created_by     INTEGER REFERENCES admin_users(user_id),
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (valid_to_ms IS NULL OR valid_to_ms > valid_from_ms)
);
CREATE UNIQUE INDEX ux_prices_current ON product_prices (product_id) WHERE is_current = 1;
CREATE INDEX ix_prices_product ON product_prices (product_id, valid_from_ms);

-- ---------------------------------------------------------------- models
CREATE TABLE model_versions (
  model_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,           -- e.g. yolo11s-s0-20261025
  family          TEXT,
  size            TEXT,
  format          TEXT,                           -- pt / engine / onnx / weights
  weights_path    TEXT,
  class_names     TEXT,                           -- JSON array from model.names (filled from /health)
  map50_95        REAL,
  latency_p95_ms  REAL,                           -- benchmark (RTX 5090), not live latency
  params          TEXT,
  gflops          REAL,
  conf_threshold  REAL NOT NULL DEFAULT 0.70,
  is_active       INTEGER NOT NULL DEFAULT 0,
  activated_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX ux_model_active ON model_versions (is_active) WHERE is_active = 1;

-- ---------------------------------------------------------------- people
CREATE TABLE admin_users (
  user_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash    TEXT NOT NULL,                 -- bcrypt
  display_name     TEXT NOT NULL,
  initials         TEXT,
  role             TEXT NOT NULL CHECK (role IN ('admin','staff')),
  failed_attempts  INTEGER NOT NULL DEFAULT 0,
  locked_until_ms  INTEGER,
  last_login_at    TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------- shopping
CREATE TABLE shopping_sessions (
  session_id      TEXT PRIMARY KEY,               -- UUID v4
  cart_id         INTEGER NOT NULL REFERENCES carts(cart_id),
  model_id        INTEGER REFERENCES model_versions(model_id),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','checked_out','abandoned','timeout')),
  started_at_ms   INTEGER NOT NULL,
  ended_at_ms     INTEGER,
  pdpa_consent    INTEGER NOT NULL DEFAULT 0,
  gender          TEXT,                           -- optional survey answer (anonymous)
  age_range       TEXT,
  item_count      INTEGER,                        -- filled at session close
  total_auto      REAL,                           -- total computed by the system
  total_checkout  REAL,                           -- total from POS (ground truth)
  checkout_code   TEXT UNIQUE                     -- e.g. SC-8F1C-0742 shown as QR on C-07
);
CREATE UNIQUE INDEX ux_sessions_active_cart ON shopping_sessions (cart_id) WHERE status = 'active';
CREATE INDEX ix_sessions_started ON shopping_sessions (started_at_ms);

CREATE TABLE cart_events (
  event_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL REFERENCES shopping_sessions(session_id),
  event_type      TEXT NOT NULL
                  CHECK (event_type IN ('START','ADD','REMOVE','CORRECTION','CHECKOUT','ABANDONED','TIMEOUT')),
  product_id      INTEGER REFERENCES products(product_id),   -- NULL for START/CHECKOUT/...
  qty_delta       INTEGER NOT NULL DEFAULT 0,
  qty_after       INTEGER,                                   -- quantity of product_id after the event
  unit_price      REAL,                                      -- price snapshot at event time
  confidence      REAL,
  source          TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','customer','staff','system')),
  frame_id        INTEGER REFERENCES frames(frame_id),       -- evidence frame
  local_track_id  INTEGER,
  note            TEXT,
  t_ms            INTEGER NOT NULL
);
CREATE INDEX ix_events_session ON cart_events (session_id, t_ms);
CREATE INDEX ix_events_product ON cart_events (product_id, event_type);

-- quantity per product over time, SCD Type 2 (one current row per session+product)
CREATE TABLE cart_item_history (
  history_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL REFERENCES shopping_sessions(session_id),
  product_id          INTEGER NOT NULL REFERENCES products(product_id),
  qty                 INTEGER NOT NULL CHECK (qty >= 0),
  unit_price          REAL,
  valid_from_ms       INTEGER NOT NULL,
  valid_to_ms         INTEGER,
  is_current          INTEGER NOT NULL DEFAULT 1,
  caused_by_event_id  INTEGER REFERENCES cart_events(event_id)
);
CREATE UNIQUE INDEX ux_item_history_current ON cart_item_history (session_id, product_id) WHERE is_current = 1;

-- ---------------------------------------------------------------- frames / detections
-- one row per frame that reached the server while the cart had an active session
CREATE TABLE frames (
  frame_id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id           TEXT NOT NULL REFERENCES shopping_sessions(session_id),
  cart_id              INTEGER NOT NULL REFERENCES carts(cart_id),
  model_id             INTEGER REFERENCES model_versions(model_id),
  seq                  INTEGER NOT NULL,          -- per-device sequence number
  width                INTEGER,
  height               INTEGER,
  jpeg_bytes           INTEGER,
  t_capture_device_ms  REAL,                      -- device clock; informational only, never subtract from server time
  t_received_ms        INTEGER NOT NULL,
  t_infer_start_ms     INTEGER,
  t_infer_end_ms       INTEGER,
  infer_ms             REAL,                      -- reported by the inference service
  t_tracker_ms         INTEGER,
  t_db_ms              INTEGER,
  t_pushed_ms          INTEGER,
  dropped              INTEGER NOT NULL DEFAULT 0, -- 1 = dropped from the per-cart queue
  error                TEXT,                      -- e.g. INFER_TIMEOUT
  image_path           TEXT                       -- set only for event / reported frames
);
CREATE INDEX ix_frames_session ON frames (session_id, seq);
CREATE INDEX ix_frames_received ON frames (t_received_ms);

CREATE TABLE detections (
  detection_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  frame_id        INTEGER NOT NULL REFERENCES frames(frame_id) ON DELETE CASCADE,
  product_id      INTEGER REFERENCES products(product_id),  -- NULL = unknown class_name
  class_name      TEXT NOT NULL,
  conf            REAL NOT NULL,
  x1 REAL NOT NULL, y1 REAL NOT NULL, x2 REAL NOT NULL, y2 REAL NOT NULL,  -- normalized 0-1
  in_roi          INTEGER NOT NULL DEFAULT 0,
  accepted        INTEGER NOT NULL DEFAULT 0,     -- passed conf threshold and ROI
  local_track_id  INTEGER
);
CREATE INDEX ix_detections_frame ON detections (frame_id);

-- ---------------------------------------------------------------- feedback / alerts
CREATE TABLE user_feedback (
  feedback_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT NOT NULL REFERENCES shopping_sessions(session_id),
  frame_id       INTEGER REFERENCES frames(frame_id),
  issue_type     TEXT NOT NULL CHECK (issue_type IN ('missing','extra','wrong_class','wrong_qty')),
  product_id     INTEGER REFERENCES products(product_id),
  comment        TEXT,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','exported')),
  created_at_ms  INTEGER NOT NULL,
  reviewed_by    INTEGER REFERENCES admin_users(user_id),
  reviewed_at    TEXT
);
CREATE INDEX ix_feedback_session ON user_feedback (session_id);

-- lookup instead of CHECK so later migrations can add types without rebuilding alerts
CREATE TABLE alert_types (
  alert_type        TEXT PRIMARY KEY,
  default_severity  TEXT NOT NULL CHECK (default_severity IN ('info','warning','danger')),
  description_th    TEXT
);
INSERT INTO alert_types (alert_type, default_severity, description_th) VALUES
  ('DISCONNECTED',      'danger',  'ไม่มีเฟรมจากกล้องรถเข็นเกินเวลาที่กำหนด'),
  ('LOW_CONF',          'warning', 'ความมั่นใจของโมเดลต่ำกว่าเกณฑ์ต่อเนื่อง'),
  ('HIGH_LATENCY',      'warning', 'latency p95 เกินเกณฑ์'),
  ('CHECKOUT_MISMATCH', 'info',    'ยอดระบบไม่ตรงกับยอด POS'),
  ('INFERENCE_ERROR',   'warning', 'เรียก inference ไม่สำเร็จ / timeout'),
  ('CUSTOMER_REPORT',   'info',    'ลูกค้าแจ้งรายการไม่ถูกต้อง');

CREATE TABLE alerts (
  alert_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_type       TEXT NOT NULL REFERENCES alert_types(alert_type),
  severity         TEXT NOT NULL CHECK (severity IN ('info','warning','danger')),
  cart_id          INTEGER REFERENCES carts(cart_id),
  session_id       TEXT REFERENCES shopping_sessions(session_id),
  message          TEXT NOT NULL,
  payload          TEXT,                          -- JSON
  created_at_ms    INTEGER NOT NULL,
  acknowledged_by  INTEGER REFERENCES admin_users(user_id),
  acknowledged_at_ms INTEGER,
  resolved_at_ms   INTEGER
);
CREATE INDEX ix_alerts_open ON alerts (resolved_at_ms, created_at_ms);

-- ---------------------------------------------------------------- views
-- "change of mind" rate per product: units removed / units added (auto + corrections excluded)
CREATE VIEW v_product_abandon AS
SELECT p.product_id, p.class_name, p.name_th,
       COALESCE(SUM(CASE WHEN e.event_type = 'ADD'    THEN  e.qty_delta END), 0) AS added,
       COALESCE(SUM(CASE WHEN e.event_type = 'REMOVE' THEN -e.qty_delta END), 0) AS removed,
       ROUND(1.0 * COALESCE(SUM(CASE WHEN e.event_type = 'REMOVE' THEN -e.qty_delta END), 0)
             / NULLIF(SUM(CASE WHEN e.event_type = 'ADD' THEN e.qty_delta END), 0), 4) AS abandon_rate
FROM products p
LEFT JOIN cart_events e ON e.product_id = p.product_id AND e.event_type IN ('ADD','REMOVE')
GROUP BY p.product_id;

-- market-basket pairs over checked-out sessions: support and lift
CREATE VIEW v_cooccurrence AS
WITH basket AS (
  SELECT e.session_id, e.product_id
  FROM cart_events e JOIN shopping_sessions s ON s.session_id = e.session_id
  WHERE s.status = 'checked_out' AND e.product_id IS NOT NULL
  GROUP BY e.session_id, e.product_id
  HAVING SUM(e.qty_delta) > 0
),
n AS (SELECT COUNT(DISTINCT session_id) AS total FROM basket),
single AS (SELECT product_id, COUNT(*) AS cnt FROM basket GROUP BY product_id),
pair AS (
  SELECT a.product_id AS product_a, b.product_id AS product_b, COUNT(*) AS together
  FROM basket a JOIN basket b ON a.session_id = b.session_id AND a.product_id < b.product_id
  GROUP BY a.product_id, b.product_id
)
SELECT pair.product_a, pair.product_b, pair.together AS sessions_together,
       ROUND(1.0 * pair.together / n.total, 4) AS support,
       ROUND((1.0 * pair.together / n.total) / ((1.0 * sa.cnt / n.total) * (1.0 * sb.cnt / n.total)), 3) AS lift
FROM pair, n
JOIN single sa ON sa.product_id = pair.product_a
JOIN single sb ON sb.product_id = pair.product_b;

-- per-stage server latency of processed frames (all values in ms)
CREATE VIEW v_frame_latency AS
SELECT f.frame_id, f.session_id, f.cart_id, f.seq, f.t_received_ms,
       f.t_infer_start_ms - f.t_received_ms  AS queue_ms,
       f.t_infer_end_ms   - f.t_infer_start_ms AS infer_call_ms,
       f.infer_ms                             AS infer_model_ms,
       f.t_tracker_ms     - f.t_infer_end_ms  AS tracker_ms,
       f.t_db_ms          - f.t_tracker_ms    AS db_ms,
       f.t_pushed_ms      - f.t_db_ms         AS push_ms,
       f.t_pushed_ms      - f.t_received_ms   AS server_total_ms
FROM frames f
WHERE f.dropped = 0 AND f.error IS NULL;
