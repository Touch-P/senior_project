# INSTRUCTION: Smart Cart YOLO Research (ภาค 2) — ส่วนระบบเว็บ

ที่มา: เอกสาร instruction ภาค 2 (Oct 21, 2026) คัดเฉพาะส่วนที่เกี่ยวกับระบบ real-time, ฐานข้อมูล และการวัด latency (ส่วนที่ 2, 3, 4.5, 4.6) ส่วนที่ 1 (train/benchmark YOLO) และ 4.1–4.4 ไม่ได้ใส่ไว้เพราะไม่เกี่ยวกับงานใน repo นี้

หมายเหตุ: ต้นฉบับใช้ FastAPI + React แต่โปรเจคตัดสินใจใช้ **Node.js + SQLite + UI vanilla เดิม** ตามทางเลือกท้ายหัวข้อ 2.1 ถ้าเนื้อหาด้านล่างขัดกับ `CLAUDE_CODE_BRIEF.md` ให้ยึด brief

## ภาพรวม

ภาค 2 ยกระดับโปรเจคเป็นงานวิจัยเชิงระบบ 3 ชั้น: benchmark YOLO ทุกรุ่นบน dataset เดิมภายใต้เงื่อนไขเดียวกัน, นำรุ่นที่ดีที่สุดไปใช้ในระบบแสดงราคาแบบ real-time และวัด latency end-to-end บน cloud กล่อง Cart tracker คือ contribution ใหม่ของภาค 2

**จุดตั้งต้นจากครึ่งแรก:** 1,388 ภาพ (หลัง augment 3,332), 11 คลาส, YOLOv9 (gelan-c) ได้ mAP50-95 บน test = 0.936

### คำถามวิจัย

1. **RQ1** YOLO รุ่นใดให้ mAP50-95 สูงสุดกับสินค้าในรถเข็น และความต่างระหว่างรุ่นมีนัยสำคัญทางสถิติหรือไม่
2. **RQ2** รุ่นใดอยู่บน Pareto front ของความแม่นยำเทียบกับ latency, จำนวนพารามิเตอร์ และ GFLOPs
3. **RQ3** ระบบเต็มบน cloud ได้ latency p95 เท่าไร และรองรับรถเข็นพร้อมกันได้กี่คันก่อนเกินเกณฑ์
4. **RQ4** การติดตามสถานะตามเวลา (temporal tracking) ลดความผิดพลาดของรายการในรถเข็นได้เท่าไรเมื่อเทียบกับการนับรายเฟรม

### Tracker งานส่วนระบบ (จากส่วนที่ 0)

| ID | งาน | Definition of done |
| --- | --- | --- |
| P2.1 | ออกแบบ + สร้าง database (migration + seed สินค้า) | รัน init แล้วได้ `smartcart.db` ที่มีตารางครบ |
| P2.2 | Inference service (YOLO) | POST ภาพ → JSON detections < 50 ms บน GPU |
| P2.3 | Cart state tracker (smoothing + event ADD/REMOVE) | ผ่าน unit test กรณีบัง/สั่น/หยิบออก |
| P2.4 | Backend API + WebSocket | หน้าจอลูกค้าได้ราคาใหม่ภายใน 1 วินาที |
| P2.5 | หน้าจอลูกค้า | แสดงรายการ, จำนวน, ราคารวม real-time |
| P2.6 | Dashboard ผู้ดูแล | live carts + สินค้าที่ถูกหยิบออก + co-occurrence |
| P2.7 | Device client (webcam / มือถือ) | ส่งภาพต่อเนื่อง 2–5 fps, reconnect เองได้ |
| P3.1 | Deploy ขึ้น cloud (GPU instance + DB) | เข้าเว็บผ่าน HTTPS ได้ |
| P3.2 | ใส่ timestamp ทุกช่วงของ pipeline | ทุกเฟรมมี latency breakdown ใน DB |
| P3.3 | ทดลอง latency ตาม matrix (เครือข่าย × ขนาดภาพ × รุ่นโมเดล) | latency ทุกเฟรมถูกบันทึกลง SQLite |
| P3.4 | Load test 1/5/10/20 รถเข็น | รันครบทุกระดับจำนวนรถเข็น |
| P4.1 | ทดสอบ scenario จริง 30 sessions + แก้ปัญหา | cart accuracy ≥ 95% |
| P4.3 | ทำ demo วิดีโอสำรอง (กันเน็ตล่มวันสอบ) | วิดีโอ 3 นาที |

## ส่วนที่ 2: Web service real-time และ dashboard

ระบบมี 4 ชิ้น: client กล้องบนรถเข็นส่งภาพ 2–5 fps, backend ทำ inference + tracker + บันทึก DB, หน้าจอลูกค้าแสดงรายการและราคารวม, dashboard ผู้ดูแลดูรถเข็นสดและวิเคราะห์การหยิบเข้า–ออก

### 2.1 Tech stack

| ชั้น | เลือกใช้ (ต้นฉบับ) | เหตุผล |
| --- | --- | --- |
| Device | หน้าเว็บบนมือถือ/แท็บเล็ตติดรถเข็น (กล้องหลัง = webcam, จอ = LCD) หรือ Raspberry Pi + webcam USB | มือถือเครื่องเดียวได้ทั้งกล้องและจอ ไม่ต้องซื้อฮาร์ดแวร์ |
| Backend | FastAPI + Uvicorn, WebSocket, Ultralytics (TensorRT engine) | inference ต้องเป็น Python อยู่แล้ว |
| Database | SQLite (ไฟล์ `smartcart.db` อยู่เครื่องเดียวกับ backend) | ไม่ต้องตั้ง server, backup แค่คัดลอกไฟล์ |
| Frontend | React + Vite, Recharts | ตาม scope เดิม |
| Deploy | Docker Compose (mount โฟลเดอร์ `db/` เป็น volume) | ย้ายเครื่องได้ทันที ไฟล์ DB ไม่หายเมื่อ rebuild |

SQLite เหมาะกับ prototype นี้เพราะมี backend process เดียวเป็นผู้เขียน แต่ต้องตั้งค่า 3 อย่างทุกครั้งที่เปิด connection: `PRAGMA journal_mode=WAL;` (dashboard อ่านได้ระหว่างที่ tracker เขียน), `PRAGMA foreign_keys=ON;` (SQLite ปิดไว้เป็นค่าเริ่มต้น) และ `PRAGMA busy_timeout=5000;` ให้เขียนผ่าน writer เดียว (คิว) และ commit เป็นก้อนราว 1 วินาทีครั้ง แทนการ commit ทีละเฟรม

ขอบเขตเดิมระบุ backend เป็น JavaScript การใช้ FastAPI ต้องแจ้งอาจารย์และเขียนเหตุผลในบทที่ 3 **ถ้าต้องคง JavaScript ให้แยกเป็น Node.js (API + WebSocket + dashboard) กับ Python inference service ที่คุยกันผ่าน HTTP โดยให้ Node.js เป็นผู้เขียน SQLite เพียงฝั่งเดียว** ← โปรเจคเลือกทางนี้

### 2.2 Flow ต่อ 1 เฟรม

1. Device จับภาพ ย่อด้านยาวเหลือ 640 px บีบเป็น JPEG quality ~70 แนบ `seq` และ `t_capture`
2. ส่งเป็น **binary WebSocket message** ไป `/ws/device/{cart_id}` (base64 ทำให้ขนาดโตขึ้นราว 33%)
3. Backend ใส่คิว ถ้าคิวของรถเข็นนั้นค้างเกิน 2 เฟรม ให้ทิ้งเฟรมเก่า (ทำให้ข้อมูลสดเสมอ)
4. Inference → กรอง conf ≥ τ (เริ่มที่ 0.7 จาก F1 curve ครึ่งแรก) และกรองเฉพาะกล่องที่อยู่ใน **ROI ตะกร้า** (polygon ที่กำหนดต่อรถเข็น) เพื่อไม่นับสินค้าบนชั้นวางที่ติดมาในภาพ
5. Tracker อัปเดตสถานะรถเข็น ถ้ามี ADD/REMOVE → เขียน `cart_events` + `cart_item_history`
6. Push `cart_update` ไปหน้าจอลูกค้า และ `live_update` ไป dashboard
7. บันทึก timestamp ทุกช่วงลงตาราง `frames` (ใช้ในส่วนที่ 3)

### 2.3 Cart state tracker (หัวใจของ RQ4)

การนับรายเฟรมกระพริบเพราะมือบัง สินค้าซ้อน หรือ confidence แกว่ง tracker เปลี่ยน detection ที่แกว่งให้เป็นรายการที่นิ่ง:

1. นับจำนวนต่อคลาสในแต่ละเฟรม `n_t(c)`
2. เก็บหน้าต่าง W เฟรมล่าสุด (เริ่ม W = 8 ≈ 2 วินาทีที่ 4 fps) ค่าที่นิ่ง = **mode** ของ `n_t(c)` ในหน้าต่าง
3. **ADD** เมื่อค่านิ่งมากกว่าที่ commit ไว้ติดกัน K = 3 รอบ
4. **REMOVE** ต้องใช้หลักฐานแรงกว่า: ค่านิ่งน้อยกว่าที่ commit ไว้นาน 2W เฟรม เพราะการบังทำให้จำนวนลดชั่วคราวบ่อยกว่าการหยิบออกจริง (brief หัวข้อ 7.2 เพิ่มเงื่อนไข exit evidence ทับข้อนี้)
5. ระหว่างที่ยังไม่นิ่ง ส่ง `state: "updating"` ให้หน้าจอขึ้น "กำลังตรวจสอบ…" แทนการเปลี่ยนราคาไปมา

ทดลองเทียบ 3 แบบใน RQ4: (a) นับรายเฟรม, (b) sliding window + hysteresis ข้างบน, (c) ByteTrack ของ Ultralytics (`model.track(..., tracker="bytetrack.yaml")`) นับ track ID ใน ROI วัดด้วย **cart accuracy** = สัดส่วน session ที่รายการตอนจบตรงกับของจริงทุกชิ้น และ **จำนวน event ผิด** ต่อ session → tracker ควรสลับโหมด (a)/(b)/(c) ได้ด้วย config เพื่อใช้ทดลอง

### 2.4 หน้าจอลูกค้า

- รายการสินค้า: รูป, ชื่อไทย, จำนวน, ราคาต่อชิ้น, ราคารวมย่อย และ **ราคารวมตัวใหญ่** ด้านล่าง
- ไฮไลต์รายการที่เพิ่ง ADD 2 วินาที, รายการที่ REMOVE ขีดฆ่าแล้วหายไป
- แถบสถานะ: เชื่อมต่อ / กำลังตรวจสอบ / ขาดการเชื่อมต่อ (เมื่อหลุด แสดงรายการล่าสุดค้างไว้ ไม่ล้างเป็นศูนย์)
- ปุ่ม "รายการไม่ถูกต้อง" → บันทึก `user_feedback` พร้อมเฟรมนั้น (ใช้ทำ retraining ภายหลัง)
- ปุ่มจบการซื้อ → สรุปยอด + QR สำหรับพนักงานยืนยันที่จุดชำระเงิน

### 2.5 Dashboard ผู้ดูแล

| หน้า | สิ่งที่แสดง | ข้อมูลจาก |
| --- | --- | --- |
| Live | การ์ดรถเข็นที่ active: รายการ, ยอดรวม, อัปเดตล่าสุด, alert | `shopping_sessions`, `cart_item_history` (is_current) |
| Session timeline | เส้นเวลา ADD/REMOVE ของแต่ละ session พร้อมภาพ ณ เหตุการณ์ | `cart_events`, `frames.image_path` |
| สินค้าที่ถูกหยิบออก | อัตราเปลี่ยนใจต่อสินค้า = REMOVE ÷ ADD, เวลาที่อยู่ในรถเข็นก่อนถูกนำออก | view `v_product_abandon` |
| ซื้อคู่กัน | คู่สินค้าที่อยู่ใน session เดียวกันบ่อย พร้อมค่า support และ lift | view `v_cooccurrence` |
| ภาพรวมร้าน | จำนวน session ต่อชั่วโมง, ยอดเฉลี่ยต่อรถเข็น, เวลา session เฉลี่ย | `shopping_sessions` |
| Model monitor | confidence ต่อคลาส, latency p95 ตามเวลา, รุ่นโมเดลที่ใช้, feedback ที่ลูกค้าแจ้ง | `detections`, `frames`, `user_feedback` |
| จัดการสินค้า | เพิ่ม/แก้ราคา (เก็บประวัติราคา) | `products`, `product_prices` |

### 2.6 API

| Method | Path | ใช้ทำอะไร |
| --- | --- | --- |
| WS | `/ws/device/{cart_id}` | device ส่งเฟรม (binary) และรับ ack + `server_ts` |
| WS | `/ws/display/{session_id}` | หน้าจอลูกค้ารับ `cart_update` |
| WS | `/ws/admin` | dashboard รับ `live_update` และ alert |
| POST | `/api/sessions` | เริ่ม session เมื่อสแกน QR รถเข็น |
| GET | `/api/sessions/{id}` | ดึงสถานะล่าสุด (ใช้ตอน reconnect) |
| POST | `/api/sessions/{id}/feedback` | ลูกค้าแจ้งรายการผิด |
| POST | `/api/sessions/{id}/checkout` | ปิด session + ยอดจริงจาก POS (ground truth) |
| GET | `/api/admin/analytics/abandon?from=&to=` | อัตราเปลี่ยนใจต่อสินค้า |
| GET | `/api/admin/analytics/cooccurrence?min_support=` | คู่สินค้าที่ซื้อคู่กัน |
| GET | `/api/admin/latency?window=1h` | p50/p95/p99 แยกตามช่วง |
| CRUD | `/api/admin/products`, `/api/admin/prices` | จัดการสินค้าและราคา |

```json
// server → หน้าจอลูกค้า
{"type": "cart_update", "session_id": "8f1c…", "state": "stable",
 "items": [{"product_id": 6, "name": "เลย์ รสดั้งเดิม ห่อใหญ่", "qty": 2,
            "unit_price": 35.00, "subtotal": 70.00}],
 "total": 70.00, "frame_seq": 1532, "t_server_sent": 1761066123456}
```

### 2.7 Database schema (SQLite)

แบ่ง 4 กลุ่ม: master data (ร้าน อุปกรณ์ สินค้า ราคา โมเดล), session และสถานะรถเข็น (SCD Type 2), ข้อมูลดิบจากโมเดล (เฟรม detection + timestamp latency) และ feedback/alert สำหรับปรับปรุงระบบ

```sql
-- db/schema.sql  (เวลาที่ใช้วัด latency เก็บเป็น epoch มิลลิวินาที INTEGER, เวลาทั่วไปเก็บเป็น TEXT ISO-8601)
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ===== Master data =====
CREATE TABLE stores (
  store_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  branch_code  TEXT UNIQUE,
  timezone     TEXT DEFAULT 'Asia/Bangkok'
);

CREATE TABLE devices (
  device_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id      INTEGER REFERENCES stores(store_id),
  device_type   TEXT,                       -- phone / raspberry_pi
  camera_desc   TEXT,
  app_version   TEXT,
  registered_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  TEXT
);

CREATE TABLE carts (
  cart_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    INTEGER REFERENCES stores(store_id),
  device_id   INTEGER REFERENCES devices(device_id),
  label       TEXT,                         -- เลขรถเข็นที่พิมพ์บน QR
  roi_polygon TEXT,                         -- JSON: [[x,y],...] normalized 0-1
  status      TEXT DEFAULT 'active' CHECK (status IN ('active','maintenance'))
);

CREATE TABLE products (
  product_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  class_name  TEXT UNIQUE NOT NULL,         -- ตรงกับ label ในโมเดล เช่น lay_big_ori
  sku         TEXT, barcode TEXT,
  name_th     TEXT NOT NULL, brand TEXT, category TEXT, size_desc TEXT,
  weight_g    REAL,                         -- ใช้ต่อยอด sensor น้ำหนัก
  image_url   TEXT,
  is_active   INTEGER DEFAULT 1,            -- 0/1
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE product_prices (               -- ประวัติราคา (SCD2)
  price_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(product_id),
  store_id    INTEGER REFERENCES stores(store_id),
  price       REAL NOT NULL,
  promo_price REAL,
  valid_from  TEXT NOT NULL,
  valid_to    TEXT                          -- NULL = ราคาปัจจุบัน
);

CREATE TABLE model_versions (
  model_version_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT,                      -- yolo11s-20261104
  yolo_family    TEXT, size TEXT,
  weights_path   TEXT, format TEXT,         -- pt / engine / onnx
  imgsz          INTEGER, conf_threshold REAL,
  deployed_at    TEXT, is_active INTEGER DEFAULT 0
);

-- ===== Session & สถานะรถเข็น =====
CREATE TABLE shopping_sessions (
  session_id       TEXT PRIMARY KEY,        -- uuid4
  cart_id          INTEGER REFERENCES carts(cart_id),
  store_id         INTEGER REFERENCES stores(store_id),
  model_version_id INTEGER REFERENCES model_versions(model_version_id),
  started_at       TEXT DEFAULT CURRENT_TIMESTAMP,
  ended_at         TEXT,
  status           TEXT DEFAULT 'active'
                   CHECK (status IN ('active','checked_out','abandoned','timeout')),
  total_auto       REAL,                    -- ยอดที่ระบบคำนวณ
  total_checkout   REAL,                    -- ยอดจริงจาก POS (ground truth)
  item_count       INTEGER
);

CREATE TABLE cart_events (
  event_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL REFERENCES shopping_sessions(session_id),
  product_id        INTEGER REFERENCES products(product_id),
  event_type        TEXT NOT NULL CHECK (event_type IN ('ADD','REMOVE','CORRECTION','CHECKOUT')),
  qty_delta         INTEGER NOT NULL,
  unit_price        REAL,                   -- snapshot ราคา ณ ตอนนั้น
  confidence_avg    REAL,
  source            TEXT DEFAULT 'auto',    -- auto / customer / staff
  evidence_frame_id INTEGER,
  occurred_at_ms    INTEGER NOT NULL
);
CREATE INDEX ix_events_session ON cart_events (session_id, occurred_at_ms);

CREATE TABLE cart_item_history (           -- SCD Type 2
  history_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL REFERENCES shopping_sessions(session_id),
  product_id   INTEGER NOT NULL REFERENCES products(product_id),
  qty          INTEGER NOT NULL,
  unit_price   REAL,
  valid_from_ms INTEGER NOT NULL,
  valid_to_ms   INTEGER,                    -- NULL = ยังเป็นสถานะปัจจุบัน
  is_current   INTEGER DEFAULT 1,
  caused_by_event_id INTEGER REFERENCES cart_events(event_id)
);
CREATE UNIQUE INDEX ux_item_current ON cart_item_history (session_id, product_id) WHERE is_current = 1;

-- ===== ข้อมูลดิบจากโมเดล + latency (epoch ms) =====
CREATE TABLE frames (
  frame_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT REFERENCES shopping_sessions(session_id),
  seq             INTEGER,
  t_capture_ms    INTEGER,   -- นาฬิกา device
  t_received_ms   INTEGER,   -- ตั้งแต่ตรงนี้ใช้นาฬิกา server
  t_infer_start_ms INTEGER,
  t_infer_end_ms  INTEGER,
  t_tracker_ms    INTEGER,
  t_db_ms         INTEGER,
  t_pushed_ms     INTEGER,
  rtt_ms          REAL,      -- device วัด round-trip เอง
  image_bytes     INTEGER, width INTEGER, height INTEGER,
  image_path      TEXT,      -- เก็บไฟล์ภาพบนดิสก์ เฉพาะเฟรมที่เกิด event / ถูกแจ้งผิด
  num_detections  INTEGER,
  dropped         INTEGER DEFAULT 0
);
CREATE INDEX ix_frames_session ON frames (session_id, seq);

CREATE TABLE detections (
  detection_id INTEGER PRIMARY KEY AUTOINCREMENT,
  frame_id     INTEGER NOT NULL REFERENCES frames(frame_id) ON DELETE CASCADE,
  product_id   INTEGER REFERENCES products(product_id),
  confidence   REAL,
  x1 REAL, y1 REAL, x2 REAL, y2 REAL,       -- normalized 0-1
  track_id     INTEGER,
  in_roi       INTEGER
);
CREATE INDEX ix_det_frame ON detections (frame_id);

-- ===== Feedback, alert, ผู้ใช้ =====
CREATE TABLE user_feedback (
  feedback_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT REFERENCES shopping_sessions(session_id),
  frame_id     INTEGER REFERENCES frames(frame_id),
  reported_by  TEXT,               -- customer / staff
  issue_type   TEXT,               -- missing / extra / wrong_class / wrong_qty
  product_id   INTEGER REFERENCES products(product_id),
  note         TEXT,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE alerts (
  alert_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT, cart_id INTEGER,
  alert_type  TEXT,   -- LOW_CONF / UNSTABLE / DISCONNECTED / HIGH_LATENCY / CHECKOUT_MISMATCH
  severity    TEXT,   -- info / warning / critical
  message     TEXT,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT, resolved_by INTEGER REFERENCES admin_users(user_id)
);

CREATE TABLE admin_users (
  user_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT DEFAULT 'staff' CHECK (role IN ('admin','staff')),
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);
```

```sql
-- อัตราเปลี่ยนใจต่อสินค้า
CREATE VIEW v_product_abandon AS
SELECT p.name_th,
       SUM(CASE WHEN e.event_type = 'ADD'    THEN e.qty_delta  ELSE 0 END) AS added,
       SUM(CASE WHEN e.event_type = 'REMOVE' THEN -e.qty_delta ELSE 0 END) AS removed,
       ROUND(1.0 * SUM(CASE WHEN e.event_type = 'REMOVE' THEN -e.qty_delta ELSE 0 END)
             / NULLIF(SUM(CASE WHEN e.event_type = 'ADD' THEN e.qty_delta ELSE 0 END), 0), 3) AS abandon_rate
FROM cart_events e JOIN products p ON p.product_id = e.product_id
WHERE e.source = 'auto'
GROUP BY p.name_th;

-- คู่สินค้าที่อยู่ใน session เดียวกัน (support)
CREATE VIEW v_cooccurrence AS
WITH bought AS (
  SELECT DISTINCT session_id, product_id FROM cart_item_history WHERE qty > 0
)
SELECT a.product_id AS product_a, b.product_id AS product_b,
       COUNT(*) AS sessions_together
FROM bought a JOIN bought b
  ON a.session_id = b.session_id AND a.product_id < b.product_id
GROUP BY a.product_id, b.product_id;

-- latency แยกช่วง (มิลลิวินาที) — ลบกันได้ตรง ๆ เพราะเก็บเป็น epoch ms
CREATE VIEW v_frame_latency AS
SELECT frame_id, session_id,
  t_infer_start_ms - t_received_ms    AS queue_ms,
  t_infer_end_ms   - t_infer_start_ms AS infer_ms,
  t_tracker_ms     - t_infer_end_ms   AS tracker_ms,
  t_db_ms          - t_tracker_ms     AS db_ms,
  t_pushed_ms      - t_received_ms    AS server_total_ms,
  rtt_ms
FROM frames WHERE dropped = 0;
```

ค่า lift ของคู่สินค้าคำนวณต่อในโค้ดจาก `v_cooccurrence` (SQLite ไม่มี materialized view ถ้า query ช้าให้สร้างตารางสรุปที่อัปเดตตอนปิด session)

ตาราง `frames` และ `detections` โตเร็วที่สุด (4 fps × 10 นาที = 2,400 แถวต่อ session) ให้ลบแถวเก่ากว่า 30 วันแล้วรัน `VACUUM` เป็นระยะ เก็บภาพเป็นไฟล์บนดิสก์และใส่แค่ path ในฐานข้อมูล (ไม่เก็บภาพเป็น BLOB ใน SQLite) และเก็บเฉพาะเฟรมที่เกิด event หรือถูกแจ้งผิด สำรองข้อมูลด้วย `sqlite3 smartcart.db ".backup backup.db"` ซึ่งทำได้แม้ระบบกำลังทำงาน

## ส่วนที่ 3: ทดสอบระบบบน cloud และวัด latency

เป้าหมายที่เสนอ (ตกลงกับอาจารย์ก่อน): latency ตั้งแต่ถ่ายภาพจนราคาขึ้นจอ **p95 ≤ 500 ms** เมื่อมีรถเข็น 1 คัน และ **≤ 1 วินาที** เมื่อมี 10 คัน โดยทิ้งเฟรมไม่เกิน 5% การทดลองต้องแยกให้ได้ว่าเวลาหายไปที่ช่วงไหน ไม่ใช่วัดแค่ตัวเลขรวม

### 3.1 สภาพแวดล้อมที่เปรียบเทียบ

| รหัส | Deploy ที่ | ใช้ทำอะไร |
| --- | --- | --- |
| E1 | โน้ตบุ๊ก/PC มี GPU ใน LAN เดียวกับ device | baseline ไม่มีอินเทอร์เน็ต |
| E2 | vast.ai GPU (เครื่องในเอเชีย) + Cloudflare Tunnel ทำ HTTPS | cloud ราคาถูก ไม่มี SLA |
| E3 | Cloud provider region ใกล้กรุงเทพที่มี GPU (เช่น T4 หรือ L4) | cloud แบบ production |
| E4 | E3 แต่ใช้ CPU อย่างเดียว | แสดงว่าต้องใช้ GPU จริงไหม |

### 3.2 ปัจจัยที่ปรับ

- **เครือข่าย:** Wi-Fi, 4G/5G (มือถือ hotspot) และจำลองด้วย `tc qdisc add dev eth0 root netem delay 100ms 20ms loss 1%`
- **ขนาดภาพ:** ด้านยาว 480 / 640 px × JPEG quality 50 / 70 / 90
- **โมเดล:** 3 รุ่นที่ดีที่สุดจากส่วนที่ 1, แบบ PyTorch เทียบ TensorRT FP16
- **จำนวนรถเข็นพร้อมกัน:** 1, 5, 10, 20
- **fps ต่อรถเข็น:** 2 และ 5

ไม่ต้องรันทุก combination: ใช้ค่ามาตรฐาน (Wi-Fi, 640, q70, รุ่นที่ชนะ, TensorRT, 1 คัน, 4 fps) แล้วเปลี่ยนทีละปัจจัย (one-factor-at-a-time)

### 3.3 วิธีวัดแต่ละช่วง

นาฬิกาของ device กับ server ไม่ตรงกัน ห้ามเอาเวลา device ลบเวลา server ให้วัดแบบนี้:

- **ฝั่ง server (นาฬิกาเดียว):** `queue`, `infer`, `tracker`, `db`, `server_total` จากคอลัมน์ในตาราง `frames` (view `v_frame_latency`)
- **ฝั่ง device (นาฬิกาเดียว):** E2E = เวลาที่ได้รับ `cart_update` ที่อ้าง `frame_seq` นั้น − `t_capture` วัดด้วย `performance.now()`
- **เครือข่าย** ≈ E2E − server_total − เวลาเข้ารหัสภาพบน device
- **เวลาแสดงผล:** บันทึก `performance.now()` ใน `requestAnimationFrame` แรกหลัง render ราคาใหม่
- **Event latency (มุมผู้ใช้):** ถ่ายวิดีโอ slow-motion ให้เห็นทั้งมือที่วางสินค้าและจอ นับเฟรมตั้งแต่สินค้าผ่านขอบตะกร้าจนราคาเปลี่ยน ค่านี้รวมเวลาหน่วงของ tracker (หน้าต่าง W) ด้วย — รายงานคู่กับ cart accuracy เพราะ W ใหญ่ขึ้น = นิ่งขึ้นแต่ช้าลง

```javascript
// device: วัด end-to-end ด้วยนาฬิกาของ device เท่านั้น
const sent = new Map();
function sendFrame(ws, jpegBlob, seq) {
  sent.set(seq, performance.now());
  const header = new TextEncoder().encode(JSON.stringify({ seq }) + "\n");
  ws.send(new Blob([header, jpegBlob]));
}
ws.onmessage = (msg) => {
  const d = JSON.parse(msg.data);
  if (d.type === "cart_update" && sent.has(d.frame_seq)) {
    const e2e = performance.now() - sent.get(d.frame_seq);
    navigator.sendBeacon("/api/metrics", JSON.stringify({ seq: d.frame_seq, e2e }));
    sent.delete(d.frame_seq);
  }
};
```

### 3.4 Load test

อัดวิดีโอการหยิบสินค้าจริง 10 คลิป แล้วเขียน script จำลองรถเข็น N คัน แต่ละคันเล่นคลิปส่งเฟรมตามจังหวะ fps จริง (ไม่ยิงถี่เกินจริง) ไล่ N = 1 → 20 แต่ละระดับรัน 5 นาที ตัด 30 วินาทีแรก (warm-up) ทิ้ง หาจุดที่ p95 เกินเป้าหรือเฟรมถูกทิ้งเกิน 5% = ความจุของเครื่องนั้น

```python
# loadtest/sim_carts.py
import asyncio, time, cv2, websockets, json

async def cart(cart_id, video, url, fps=4, seconds=300):
    cap = cv2.VideoCapture(video); seq = 0
    async with websockets.connect(f"{url}/ws/device/{cart_id}") as ws:
        end = time.time() + seconds
        while time.time() < end:
            ok, frame = cap.read()
            if not ok: cap.set(cv2.CAP_PROP_POS_FRAMES, 0); continue
            frame = cv2.resize(frame, (640, 480))
            jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])[1].tobytes()
            await ws.send(json.dumps({"seq": seq}).encode() + b"\n" + jpg)
            seq += 1
            await asyncio.sleep(1 / fps)

async def main(n, url):
    await asyncio.gather(*[cart(i, f"clips/{i % 10}.mp4", url) for i in range(n)])

asyncio.run(main(n=10, url="wss://your-domain"))
```

ระหว่างทดสอบเก็บ GPU utilization และ memory ด้วย `nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv -l 1` และบันทึกค่าเช่าเครื่องต่อชั่วโมงเพื่อคำนวณ **ต้นทุนต่อรถเข็นต่อชั่วโมง**

## ส่วนที่ 4: ปัญหาที่อาจเกิดขึ้น (เฉพาะส่วนระบบ)

### 4.4 Tracker และการนับสินค้า

| ปัญหา | อาการ | วิธีแก้ |
| --- | --- | --- |
| รายการกระพริบ | ราคาขึ้นลงไปมา | sliding window + hysteresis (หัวข้อ 2.3), แสดง "กำลังตรวจสอบ…" |
| สินค้าถูกบัง | ระบบลบรายการทั้งที่ยังอยู่ | REMOVE ต้องใช้หลักฐานนานกว่า ADD, ถ้าลดลงพร้อมมีสินค้าใหม่บังให้ถือว่ายังอยู่ |
| สินค้าชนิดเดียวกันหลายชิ้นซ้อนกัน | 2 ห่อนับเป็น 1 | ทดลองปรับ NMS `iou` (0.5–0.8), เพิ่มภาพ train ที่มีชิ้นซ้ำ |
| นับสินค้าบนชั้นวาง | รายการโผล่เองตอนเข็นผ่านชั้น | กรองด้วย ROI ตะกร้า, ติดกล้องมุมก้มลงในตะกร้า |
| สินค้าที่ไม่รู้จัก | ทายผิดเป็นคลาสใกล้เคียง | เพิ่มคลาส `unknown_item`, alert เมื่อ confidence ต่ำต่อเนื่อง |
| `lay_big_ori` สับสนกับ `lay_party_ori` | ราคาผิด | เพิ่มภาพที่เห็นขนาดเทียบ, ใช้อัตราส่วนกล่องกับขอบตะกร้า, ต่อยอดเซนเซอร์น้ำหนัก (`products.weight_g`) |

### 4.5 Web, cloud และ latency

| ปัญหา | อาการ | วิธีแก้ |
| --- | --- | --- |
| WebSocket หลุด | จอค้าง/รายการหาย | auto-reconnect แบบ exponential backoff, พอต่อติดเรียก `GET /api/sessions/{id}` ดึงสถานะล่าสุด, heartbeat ทุก 10 วินาที |
| เฟรมแรกช้ามาก | request แรก 1–3 วินาที | warm-up โมเดลตอน start server (predict ภาพเปล่า 10 ครั้ง) |
| Latency พุ่งเมื่อรถเข็นเยอะ | คิวยาว p99 กระโดด | ทิ้งเฟรมเก่า (คิวสูงสุด 2), batch inference หลายรถเข็นพร้อมกัน, ลด fps เหลือ 2 |
| Upload ช้าบน 4G | network กิน > 60% ของ E2E | ลด JPEG quality, ส่งเฉพาะเมื่อภาพเปลี่ยน (frame differencing บน device), crop ROI ก่อนส่ง |
| Mixed content / กล้องไม่เปิด | browser ไม่ให้ใช้กล้อง | ต้องเป็น HTTPS (Cloudflare Tunnel หรือ Let's Encrypt / mkcert ใน LAN) |
| IP เปลี่ยน / เปิด port ไม่ได้ | เชื่อมต่อจากภายนอกไม่ได้ | ใช้ Cloudflare Tunnel ชี้ domain คงที่ |
| DB ช้าเมื่อข้อมูลโต | dashboard โหลดนาน | index ตาม session/เวลา, ตารางสรุปที่อัปเดตตอนปิด session, retention 30 วัน + VACUUM |
| SQLite: database is locked | tracker เขียน event ไม่ได้ช่วงโหลดหนัก | WAL + busy_timeout, ให้มี writer เดียวผ่านคิว, commit เป็นก้อน, ห้ามเก็บไฟล์ DB บน network drive |

### 4.6 ความเป็นส่วนตัว (PDPA)

กล้องบนรถเข็นอาจจับใบหน้าหรือของส่วนตัวของลูกค้า ซึ่งเป็นข้อมูลส่วนบุคคลตาม พ.ร.บ. คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 ให้ crop เฉพาะ ROI ตะกร้าบน device ก่อนส่ง (หรือมีตัวเลือก), ไม่เก็บภาพเป็นค่าเริ่มต้น, ติดป้ายแจ้ง และเขียนหัวข้อนี้ในบทที่ 3
