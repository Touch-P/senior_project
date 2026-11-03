# API และ WebSocket

Server เดียว (`npm run dev` / `npm start`) ให้บริการหน้าเว็บ `web/`, REST `/api/*` และ WebSocket `/ws/*` บนพอร์ตเดียว

| โหมด | เงื่อนไข | ฟังที่ |
| --- | --- | --- |
| HTTPS | มีไฟล์ `TLS_CERT` และ `TLS_KEY` | `HOST:PORT` (ค่าเริ่ม `0.0.0.0:8443`) + `HTTP_REDIRECT_PORT` (8080) redirect ไป HTTPS |
| HTTP (dev) | ไม่มี cert และ `NODE_ENV=development` | `127.0.0.1:PORT` เท่านั้น — มือถือเข้าไม่ได้จนกว่าจะมี cert (Phase 5) |
| ไม่ start | ไม่มี cert และ `NODE_ENV=production` | — |

## ความปลอดภัย

- **Login:** `POST /api/auth/login` ตรวจ bcrypt ที่ server ผิดครบ `LOGIN_MAX_ATTEMPTS` (3) ครั้ง → ล็อก `LOGIN_LOCK_MS` (5 นาที) ตอบเหมือนกันทั้งอีเมลที่มีและไม่มีในระบบ + จำกัด 20 ครั้งที่ผิดต่อ IP ต่อ 5 นาที
- **Session:** cookie `sc_sid` = ค่าสุ่ม 256 บิต · `HttpOnly`, `SameSite=Strict`, `Path=/` · **`Secure` อัตโนมัติเมื่อ request มาทาง HTTPS** · DB เก็บเฉพาะ HMAC-SHA256 (key = `SESSION_SECRET`) ในตาราง `admin_sessions` · หมดอายุแบบเลื่อน 12 ชม. (หรือ 7 วันถ้าเลือก "จดจำฉัน") · logout ลบแถวทันที
- **สิทธิ์:** ตรวจที่ server ทุก route — route ที่ใช้ `r.admin(...)` ใน `server/src/routes/*.js` ถูกบันทึกใน `adminOnlyRoutes` และ test วนตรวจว่า staff ได้ 403 ทุกตัว
- **CSRF:** cookie `SameSite=Strict` + request ที่เปลี่ยนข้อมูลต้องเป็น `application/json` (หรือไม่มี body) มิฉะนั้น 415 · WebSocket ตรวจ `Origin` ต้องตรงกับ host
- **Headers:** CSP (`script-src 'self'`, font จาก Google Fonts), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, HSTS เมื่อเป็น HTTPS
- **อุปกรณ์กล้อง:** token ต่อรถเข็นออกโดย admin เก็บเป็น HMAC ออกใหม่ = token เก่าใช้ไม่ได้

## รูปแบบ error

```json
{ "error": "CART_IN_USE", "message": "รถเข็น A-07 กำลังถูกใช้งาน", "cart": "A-07" }
```

`error` เป็นรหัสคงที่ให้ UI แปลงเป็นข้อความ: `VALIDATION` (+ `issues[]`), `BAD_JSON`, `JSON_REQUIRED` (415), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `INVALID_CREDENTIALS` (+ `attempts_left`), `LOCKED` (423, + `locked_until_ms`), `RATE_LIMITED` (429), `INVALID_QR`, `CART_IN_USE`, `CART_MAINTENANCE`, `SESSION_NOT_FOUND`, `SESSION_CLOSED`, `PDPA_REQUIRED`, `CART_NOT_FOUND`, `MODEL_NOT_FOUND`, `ALERT_NOT_FOUND`, `NOT_FOUND`

## REST

สิทธิ์: — = ไม่ต้อง login · **login** = admin หรือ staff · **admin** = admin เท่านั้น (staff → 403)

| Method | Path | สิทธิ์ | ทำอะไร |
| --- | --- | --- | --- |
| GET | `/api/health` | — | สถานะ server, จำนวน WebSocket |
| GET | `/api/meta` | — | ชื่อสาขา, จำนวนสินค้า / ที่โมเดลรู้จัก, โมเดล active, `demo_accounts` (true เฉพาะ development) |
| POST | `/api/auth/login` | — | `{email, password, remember?}` → `{user}` + cookie |
| POST | `/api/auth/logout` | — | ลบ session → 204 |
| GET | `/api/auth/me` | login | ผู้ใช้ปัจจุบัน |
| GET | `/api/auth/status` | — | เหมือน `/me` แต่ตอบ 200 `{user:null}` เมื่อยังไม่ login (หน้าที่แค่ปรับตาม role เช่น `device.html`) |
| POST | `/api/sessions` | — | `{qr}` หรือ `{cart: "A-07"}` → 201 `{session_id, cart, store, started_at_ms, display_ws}` |
| GET | `/api/sessions/:id` | — | `cart_update` ล่าสุด (ใช้ตอน reconnect) |
| PATCH | `/api/sessions/:id` | — | `{pdpa_consent?, gender?, age_range?}` — แบบสอบถามต้องยินยอม PDPA ก่อน |
| POST | `/api/sessions/:id/feedback` | — | `{issue_type, class_name?, comment?}` → `user_feedback` + alert `CUSTOMER_REPORT` |
| POST | `/api/sessions/:id/summary` | — | ลูกค้ากด "จบการซื้อ" → `checkout_code` (QR หน้า C-07) อายุ 10 นาที, session ยัง active |
| POST | `/api/sessions/:id/checkout` | login | พนักงานปิด session `{total_checkout?}` (ยอด POS) → ถ้าไม่ตรงสร้าง alert `CHECKOUT_MISMATCH` |
| GET | `/api/products` | login | สินค้าทั้งหมด + ราคาปัจจุบัน + `in_model` (staff ดูได้) |
| GET | `/api/admin/carts?all=1` | login | การ์ดรถเข็น: การเชื่อมต่อกล้อง, session, รายการ, ยอด, alert ล่าสุด + ตัวนับสำหรับ filter |
| GET | `/api/admin/carts/:label` | login | รถเข็นคันเดียว |
| PUT | `/api/admin/carts/:label/roi` | **admin** | `{roi_polygon: [[x,y],...]}` (3–12 จุด, 0–1) → แจ้ง admin + มือถือทันที |
| POST | `/api/admin/carts/:label/device-token` | **admin** | ออก/หมุน token กล้อง → `{token, url: "/device.html?cart=..&token=.."}` |
| GET | `/api/admin/sessions?status=&limit=` | login | รายการ session |
| GET | `/api/admin/sessions/:id` | login | รายละเอียด + timeline (`cart_events` + `frames.image_path`) |
| GET | `/api/admin/models` | login | `model_versions` |
| POST | `/api/admin/models/:name/activate` | **admin** | โหมด real: สั่ง inference โหลด weights ก่อน แล้วจึงตั้ง active + `class_names` จาก weights + sync `products.in_model` · 422 `MODEL_LOAD_FAILED` / `MODEL_UNSUPPORTED_FORMAT` / `MODEL_WEIGHTS_NOT_FOUND`, 503 `INFERENCE_DOWN`, 409 `MODEL_SWITCH_IN_PROGRESS` (DB ไม่เปลี่ยน) |
| GET | `/api/admin/inference` | login | สถานะ inference: `mode`, `ok`, `model`, `device`, `nc`, `last_error`, `health` (ผล `/health` ของ service หรือรายการ scenario ในโหมด mock) |
| GET | `/api/admin/alerts?open=0` | login | alert ที่ยังเปิดอยู่ (หรือทั้งหมด) |
| POST | `/api/admin/alerts/:id/ack` | login | รับทราบ alert |
| GET | `/api/admin/analytics/abandon?from=&to=` | login | อัตราเปลี่ยนใจต่อสินค้า (เฉพาะ event `auto`, เวลาเป็น epoch ms) |
| GET | `/api/admin/analytics/cooccurrence?min_support=` | login | คู่สินค้า + support + lift |
| GET | `/api/admin/analytics/reasons?from=&to=` | login | สรุปเหตุผล final ต่อ reason_code (จำนวน, dwell เฉลี่ย, ส่วนต่างราคาเฉลี่ย) + 20 คู่ จาก → ไป ที่พบบ่อย |
| GET | `/api/admin/latency?window=1h\|24h\|7d` | login | p50/p95/p99 ต่อช่วง + จำนวนเฟรม / ทิ้ง / error |

route ค้นหา/แก้สินค้า (`/api/admin/products/*`) มาใน Phase 7 และ `POST /api/metrics` มาใน Phase 5

### สินค้า (admin เท่านั้น · brief หัวข้อ 8)

ทุก route ผ่าน `r.admin()` staff ได้ 403 (test วนตรวจอัตโนมัติ) ทุกการแก้เขียน `product_audit` พร้อม `via` = `search_name` / `search_barcode` / `scan_camera` / `table` และส่ง `products_changed` ไป `/ws/admin`

| Method | Path | ทำอะไร |
| --- | --- | --- |
| GET | `/api/admin/products/search?q=&barcode=` | ตัวเลข 8/12/13 หลัก → ค้นบาร์โค้ดตรงตัว + `checksum_ok` / `warning` / `barcode_not_found` · ข้อความ ≥ 3 ตัว → FTS5 trigram (`name_th`, `brand`, `class_name`, `sku`) · สั้นกว่า → `LIKE` (normalize: trim, ตัวเล็ก, ตัดช่องว่าง) · เรียง ตรงตัว > ขึ้นต้นด้วย > มีคำนั้น สูงสุด 20 |
| GET | `/api/admin/products/:id` | รายละเอียด + `prices` (ประวัติ SCD2 พร้อมผู้แก้) + `audit` 30 รายการล่าสุด |
| PATCH | `/api/admin/products/:id` | แก้ข้อมูล (ชื่อ, แบรนด์, product_line, flavor, variant, หมวด, `is_active` …) · `class_name` แก้ไม่ได้ถ้า `in_model=1` (409 `CLASS_NAME_LOCKED`) |
| POST | `/api/admin/products/:id/prices` | `{price, promo_price?, valid_from_ms?}` ปิดแถวเดิม เปิดแถวใหม่ · ราคาโปร < ราคาปกติ · `valid_from` ในอนาคตรอไว้แล้วมีผลเองทุก 1 นาที · ของในรถเข็นแล้วใช้ราคาเดิม |
| POST | `/api/admin/products/:id/barcode` | `{barcode}` ตัวเลข 8–14 หลัก · ซ้ำกับสินค้าอื่น → 409 `BARCODE_TAKEN` พร้อมสินค้าเจ้าของ |
| POST | `/api/admin/products` | เพิ่มสินค้าใหม่ (`in_model=0` จนกว่าโมเดลจะรู้จัก label นี้) |

## WebSocket

| Path | ยืนยันตัวตน | ทิศทาง |
| --- | --- | --- |
| `/ws/admin` | cookie login (admin/staff) + Origin | server → `hello`, `live_update`, `cart_event`, `change_reason`, `presence`, `alert`, `alert_ack`, `model_changed`, `roi_changed`, `device_status`, `inference_status`, เฟรม binary ของรถเข็นที่ watch · client → `{"type":"watch","cart":"A-07"}` / `{"type":"watch","cart":null}` |
| `/ws/display/{session_id}` | session id (UUID) | server → `cart_update` ทันทีที่ต่อ และทุกครั้งที่รายการเปลี่ยน / ปิด session |
| `/ws/device/{cart}?token=` | device token | มือถือ → เฟรม binary, `hello` (`camera_desc`, `app_version`), `ping`; server → `config` (ROI + มี session ไหม, ส่งทันทีที่ต่อ), `session` (`active` true/false), `ack`, `processed`, `pong`, `roi_changed` |

- heartbeat: server ping ทุก 10 วินาที ตัด client ที่ไม่ตอบ · มือถือส่ง `{"type":"ping"}` ได้ → `pong`
- กล้องต่อได้ 1 เครื่องต่อรถเข็น เครื่องใหม่แทนที่เครื่องเก่า (ปิดด้วย code 4000)

**เฟรมจากมือถือ** (binary): `JSON header` + `\n` + ไบต์ JPEG, header ต้องมี `seq` (integer), ควรมี `t_capture`, `w`, `h`
**ack:** `{"type":"ack","seq":7,"server_ts":1793657808894}` ส่งทันทีที่รับเฟรม (ก่อน inference)

**cart_update** (instruction 2.6):

```json
{"type":"cart_update","session_id":"8f1c…","cart":"A-07","status":"active","state":"stable",
 "items":[{"product_id":13,"class_name":"lay_big_ori","name":"เลย์ รสดั้งเดิม ห่อใหญ่","image":"assets/products/lay_big_ori.jpg",
           "qty":2,"unit_price":31,"subtotal":62,"since_ms":1793657800000}],
 "item_count":2,"total":62,"started_at_ms":1793657700000,"frame_seq":null,"t_server_sent":1793657808894}
```

`frame_seq` คือเลขเฟรมที่ทำให้รายการเปลี่ยน

**processed** (ถึงมือถือทุกเฟรมหลัง publish): `{"type":"processed","seq":7,"detections":3,"state":"stable","t_server":…}` — มือถือวัด E2E = ส่งเฟรม → ได้ `processed` ของ seq เดียวกัน ถ้ารถเข็นไม่มี session จะได้ `{"idle":true}` (ไม่ infer ไม่บันทึก) และ inference ล้มจะได้ `error`

**เฟรมไป admin** (binary, เฉพาะคนที่ส่ง `watch` รถเข็นนั้น, ไม่เกิน 4 ภาพ/วินาที): `{"type":"frame","cart","seq","session_id","roi","detections":[{class_name,conf,box,in_roi,accepted,track_id}]}` + `
` + JPEG — ไม่มี session ก็ยังได้ภาพ (ใช้ตั้ง ROI) แต่ไม่บันทึก DB

**live_update** (ทุก admin, throttle 250 ms ต่อรถเข็น): `cart`, `session_id`, `state`, `fps`, `detections`, `server_ms`, `infer_ms`, `items`, `total`, `item_count`

**change_reason** (brief 7.6, ส่งทันทีที่สร้าง / final / voided):

```json
{"type":"change_reason","cart":"A-07","session_id":"…","reason_id":42,"status":"final","reason_code":"BRAND_SWITCH",
 "label_th":"เปลี่ยนแบรนด์","tone":"primary","from":{"class_name":"lay_big_ori","name_th":"…","qty":1},
 "to":{"class_name":"pringles_norm_ori","name_th":"…","qty":1},"price_delta":14,"dwell_ms":41000,"gap_ms":12000,
 "pending_until_ms":null,"t":1761066123456}
```

`status: "pending"` มี `pending_until_ms` สำหรับนับถอยหลัง "รอดูสินค้าที่หยิบแทน…" · **presence:** `{type:"presence", cart, class_name, unit_no, state:"OCCLUDED"|"IN_CART", cause, occluded_by, last_box}` สำหรับ badge "ถูกบัง" และกรอบเส้นประบน Live detail

## POST /api/metrics

มือถือส่งด้วย `navigator.sendBeacon` (body เป็น text/plain JSON จึงอยู่นอก guard JSON-only) ยืนยันด้วย device token:

```json
{"cart":"A-07","token":"…","items":[{"seq":41,"rtt_ms":12.5,"e2e_ms":48.1}]}
```

อัปเดต `frames.rtt_ms` / `e2e_ms` ของเฟรมล่าสุดที่มี seq นั้น ค่าทั้งสองวัดด้วยนาฬิกามือถือเท่านั้น ไม่เคยลบกับเวลา server
