-- 004_align_instruction.sql — add what 001 missed compared with instruction part 2, section 2.7
-- (docs/instruction_part2.md). Intentional differences are listed in docs/database.md.

-- stores: timezone for daily analytics / 02:00 jobs
ALTER TABLE stores ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Bangkok';

-- devices: owning store + hardware details recorded with experiments
ALTER TABLE devices ADD COLUMN store_id INTEGER REFERENCES stores(store_id);
ALTER TABLE devices ADD COLUMN camera_desc TEXT;
ALTER TABLE devices ADD COLUMN app_version TEXT;
UPDATE devices SET store_id = (SELECT c.store_id FROM carts c WHERE c.cart_id = devices.cart_id)
WHERE store_id IS NULL AND cart_id IS NOT NULL;

-- products: net weight from the label (future weight-sensor check, instruction 4.4)
ALTER TABLE products ADD COLUMN weight_g REAL CHECK (weight_g IS NULL OR weight_g > 0);

-- product_prices: optional per-store price (NULL = every store)
ALTER TABLE product_prices ADD COLUMN store_id INTEGER REFERENCES stores(store_id);
DROP INDEX ux_prices_current;
CREATE UNIQUE INDEX ux_prices_current ON product_prices (product_id, COALESCE(store_id, 0)) WHERE is_current = 1;

-- model_versions: input size is a factor of the latency matrix (instruction 3.2)
ALTER TABLE model_versions ADD COLUMN imgsz INTEGER NOT NULL DEFAULT 640;

-- cart_events: names that say what the value is
ALTER TABLE cart_events RENAME COLUMN confidence TO confidence_avg;   -- mean conf over the tracker window
ALTER TABLE cart_events RENAME COLUMN t_ms TO occurred_at_ms;

-- frames: device-measured round trip (send -> ack) next to e2e_ms (send -> cart_update)
ALTER TABLE frames ADD COLUMN rtt_ms REAL;
ALTER TABLE frames ADD COLUMN num_detections INTEGER;

-- user_feedback: who reported
ALTER TABLE user_feedback ADD COLUMN reported_by TEXT NOT NULL DEFAULT 'customer'
  CHECK (reported_by IN ('customer','staff'));

-- alerts: who closed it
ALTER TABLE alerts ADD COLUMN resolved_by INTEGER REFERENCES admin_users(user_id);

INSERT INTO alert_types (alert_type, default_severity, description_th) VALUES
  ('UNSTABLE', 'warning', 'ผลตรวจจับแกว่งต่อเนื่อง tracker ยังสรุปรายการไม่ได้');

-- v_product_abandon: count only automatic ADD/REMOVE (instruction filters source = 'auto');
-- manual staff/customer adjustments must not inflate the change-of-mind rate.
DROP VIEW v_product_abandon;
CREATE VIEW v_product_abandon AS
SELECT p.product_id, p.class_name, p.name_th,
       COALESCE(SUM(CASE WHEN e.event_type = 'ADD'    THEN  e.qty_delta END), 0) AS added,
       COALESCE(SUM(CASE WHEN e.event_type = 'REMOVE' THEN -e.qty_delta END), 0) AS removed,
       ROUND(1.0 * COALESCE(SUM(CASE WHEN e.event_type = 'REMOVE' THEN -e.qty_delta END), 0)
             / NULLIF(SUM(CASE WHEN e.event_type = 'ADD' THEN e.qty_delta END), 0), 4) AS abandon_rate
FROM products p
LEFT JOIN cart_events e ON e.product_id = p.product_id
                       AND e.event_type IN ('ADD','REMOVE') AND e.source = 'auto'
GROUP BY p.product_id;

DROP VIEW v_frame_latency;
CREATE VIEW v_frame_latency AS
SELECT f.frame_id, f.session_id, f.cart_id, f.seq, f.t_received_ms,
       f.t_infer_start_ms - f.t_received_ms  AS queue_ms,
       f.t_infer_end_ms   - f.t_infer_start_ms AS infer_call_ms,   -- = instruction infer_ms (HTTP call incl.)
       f.infer_ms                             AS infer_model_ms,  -- model time reported by the service
       f.t_tracker_ms     - f.t_infer_end_ms  AS tracker_ms,
       f.t_db_ms          - f.t_tracker_ms    AS db_ms,
       f.t_pushed_ms      - f.t_db_ms         AS push_ms,
       f.t_pushed_ms      - f.t_received_ms   AS server_total_ms,
       f.rtt_ms                               AS rtt_ms,          -- device clock only
       f.e2e_ms                               AS e2e_ms           -- device clock only
FROM frames f
WHERE f.dropped = 0 AND f.error IS NULL;
