# Roadmap และงานค้าง

ลำดับ Phase ตาม brief หัวข้อ 11 · สถานะล่าสุดดูจาก `git log` และ tag

| Phase | Branch | สถานะ |
| --- | --- | --- |
| 0 | — | เสร็จ |
| 1 | `main`, `develop` | เสร็จ (`v0.1.0-prototype`) |
| 2 | `chore/repo-structure`, `feature/db-schema`, `fix/schema-align-instruction` | เสร็จ |
| 3 | `feature/backend-core` | เสร็จ |
| 4 | `feature/inference-service` | — |
| 5 | `feature/phone-camera`, `feature/data-pipeline` | — |
| 6 | `feature/cart-presence-reasons` | — |
| 7 | `feature/admin-product-search` | — |
| 8 | `feature/ui-integration` | — |
| 9 | `feature/data-pipeline` (batch jobs) | — |

## งานที่ต้องทำเพิ่มจาก instruction ภาค 2 ([instruction_part2.md](instruction_part2.md))

### Phase 6 — tracker สลับโหมดได้สำหรับ RQ4 (instruction หัวข้อ 2.3)

RQ4 เทียบ 3 แบบ วัดด้วย **cart accuracy** (สัดส่วน session ที่รายการตอนจบตรงกับของจริงทุกชิ้น) และ **จำนวน event ผิดต่อ session**

| โหมด | ค่า config | วิธีนับ |
| --- | --- | --- |
| (a) | `TRACKER_MODE=frame` | นับรายเฟรม `n_t(c)` ตรง ๆ ไม่มี smoothing (baseline) |
| (b) | `TRACKER_MODE=window` (ค่าเริ่ม) | sliding window W=8 ใช้ mode + hysteresis: ADD เมื่อเกินติดกัน K=3, REMOVE ต้องค่านิ่งน้อยกว่านาน 2W **และ** exit evidence (brief 7.2) |
| (c) | `TRACKER_MODE=bytetrack` | ByteTrack ของ Ultralytics (`model.track(..., tracker="bytetrack.yaml", persist=True)`) นับ track ID ที่อยู่ใน ROI |

- tracker ทั้ง 3 แบบต้องมี interface เดียวกัน (รับ detections ของเฟรม → คืนจำนวนนิ่ง + event) เพื่อให้ presence/reason engine และ test scenario ใช้ร่วมกันได้
- บันทึกโหมดที่ใช้ลงใน session (เช่น `shopping_sessions` หรือ `job_runs`/ไฟล์ผลทดลอง) เพื่อแยกผลตอนวิเคราะห์ — ตัดสินใจตอนทำ Phase 6
- ต้องรัน scenario เดียวกัน (`server/test/scenarios/*.json`) ผ่านทั้ง 3 โหมดแล้วเก็บ cart accuracy / event ผิด เป็นสคริปต์ทดลองที่รันซ้ำได้
- ส่วนติดต่อ inference ของโหมด (c): ByteTrack ต้องเก็บสถานะต่อรถเข็น → **Phase 4** ให้ `POST /infer` รับ `cart_id` และ `track=true` แล้วคืน `track_id` ต่อกล่อง (แยก tracker state ต่อ `cart_id` ใน Python)

### Phase 3–5 — รูปแบบข้อความและ API ตาม instruction 2.6

- `cart_update` ต้องมี `state` (`stable` / `updating`), `items[]` (`product_id`, `name`, `qty`, `unit_price`, `subtotal`), `total`, `frame_seq`, `t_server_sent` — device ใช้ `frame_seq` วัด E2E
- REST ที่ instruction กำหนด: `POST /api/sessions`, `GET /api/sessions/{id}`, `POST /api/sessions/{id}/feedback`, `POST /api/sessions/{id}/checkout`, `GET /api/admin/analytics/abandon`, `GET /api/admin/analytics/cooccurrence`, `GET /api/admin/latency?window=`, CRUD สินค้า/ราคา
- warm-up โมเดล 10 ครั้งตอน start inference (instruction 4.5)

### Phase 5 / 9 — การวัดผล (instruction ส่วนที่ 3)

- device ส่งทั้ง `rtt_ms` (ส่ง→ack) และ `e2e_ms` (ส่ง→`cart_update`) — มีคอลัมน์แล้วใน `frames`
- บันทึก `devices.camera_desc`, `app_version` และ `model_versions.imgsz` คู่กับการทดลองแต่ละรอบ
- load test script จำลอง N รถเข็น (1/5/10/20) ตาม instruction 3.4 — ต้องส่ง token ของ device ด้วย (brief หัวข้อ 5 ข้อ 2)

### ข้อเสนอที่ยังไม่ได้ตัดสินใจ

- คลาส `unknown_item` (instruction 4.4) — ต้อง train ใหม่ จึงอยู่นอกขอบเขตรอบนี้
- crop ROI บนมือถือก่อนส่ง (instruction 4.6 / brief หัวข้อ 9) — ทำเป็นตัวเลือก ค่าเริ่มปิด
