-- 006_daily_analytics.sql — summary tables of the nightly analytics job (brief section 5, batch line).
-- One row per local day (stores.timezone) and store; the job deletes and rebuilds a day, so re-running is safe.

CREATE TABLE daily_product_stats (
  day           TEXT    NOT NULL,                       -- YYYY-MM-DD in the store's time zone
  store_id      INTEGER NOT NULL REFERENCES stores(store_id),
  product_id    INTEGER NOT NULL REFERENCES products(product_id),
  added         INTEGER NOT NULL DEFAULT 0,             -- automatic ADD units
  removed       INTEGER NOT NULL DEFAULT 0,             -- automatic REMOVE units
  purchased     INTEGER NOT NULL DEFAULT 0,             -- units in checked-out baskets
  revenue       REAL    NOT NULL DEFAULT 0,             -- purchased × unit price snapshot
  sessions      INTEGER NOT NULL DEFAULT 0,             -- sessions that touched the product
  abandon_rate  REAL,                                   -- removed / added
  computed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (day, store_id, product_id)
);

CREATE TABLE daily_cooccurrence (
  day               TEXT    NOT NULL,
  store_id          INTEGER NOT NULL REFERENCES stores(store_id),
  product_a         INTEGER NOT NULL REFERENCES products(product_id),
  product_b         INTEGER NOT NULL REFERENCES products(product_id),
  sessions_together INTEGER NOT NULL,
  baskets           INTEGER NOT NULL,                   -- checked-out baskets that day
  support           REAL    NOT NULL,                   -- n(A,B) / baskets
  confidence_ab     REAL    NOT NULL,                   -- n(A,B) / n(A)
  lift              REAL    NOT NULL,                   -- support(A,B) / (support(A) × support(B)), computed in Node.js
  computed_at_ms    INTEGER NOT NULL,
  PRIMARY KEY (day, store_id, product_a, product_b),
  CHECK (product_a < product_b)
);

CREATE TABLE daily_change_reasons (
  day             TEXT    NOT NULL,
  store_id        INTEGER NOT NULL REFERENCES stores(store_id),
  reason_code     TEXT    NOT NULL,
  n               INTEGER NOT NULL,
  avg_dwell_ms    REAL,
  avg_price_delta REAL,
  computed_at_ms  INTEGER NOT NULL,
  PRIMARY KEY (day, store_id, reason_code)
);
