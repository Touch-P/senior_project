# Roadmap และงานค้าง

ลำดับ Phase ตาม brief หัวข้อ 11 · สถานะล่าสุดดูจาก `git log` และ tag

| Phase | Branch | สถานะ |
| --- | --- | --- |
| 0 | — | เสร็จ |
| 1 | `main`, `develop` | เสร็จ (`v0.1.0-prototype`) |
| 2 | `chore/repo-structure`, `feature/db-schema`, `fix/schema-align-instruction` | เสร็จ |
| 3 | `feature/backend-core` | เสร็จ |
| 4 | `feature/inference-service` | เสร็จ ([inference.md](inference.md)) |
| 5 | `feature/phone-camera`, `feature/data-pipeline` | เสร็จ ([pipeline.md](pipeline.md), [phone-camera.md](phone-camera.md)) — รอวัดด้วยมือถือจริง |
| 6 | `feature/cart-presence-reasons` | เสร็จ ([presence-reasons.md](presence-reasons.md)) — UI ของเหตุผลต่อใน Phase 8 |
| 7 | `feature/admin-product-search` | เสร็จ (`v0.3.0`) — ค้นหา/สแกน/แก้สินค้า, ZXing ใน `web/vendor/` |
| 8 | `feature/ui-integration` | เสร็จ ([ui.md](ui.md)) — ทุกหน้าใช้ข้อมูลจริง, `?mock=1` = prototype, demo ไม่ต้องมีมือถือ |
| 9 | `feature/batch-jobs` | เสร็จ (`v0.4.0`) — [jobs.md](jobs.md) |

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
- ส่วนติดต่อ inference ของโหมด (c): ทำแล้วใน Phase 4 — `POST /infer?cart_id=&track=true` คืน `track_id` ต่อกล่อง (BYTETracker แยกต่อ `cart_id` ใน Python, `DELETE /tracks/{cart_id}` ตอนเริ่ม session) และโหมด mock คืน `track_id` จาก `id` ของวัตถุใน scenario
- เริ่ม session ใหม่ต้องเรียก `inference.resetTracks(cart)` (Phase 5/6)

### Phase 3–5 — รูปแบบข้อความและ API ตาม instruction 2.6

- `cart_update` ต้องมี `state` (`stable` / `updating`), `items[]` (`product_id`, `name`, `qty`, `unit_price`, `subtotal`), `total`, `frame_seq`, `t_server_sent` — device ใช้ `frame_seq` วัด E2E
- REST ที่ instruction กำหนด: `POST /api/sessions`, `GET /api/sessions/{id}`, `POST /api/sessions/{id}/feedback`, `POST /api/sessions/{id}/checkout`, `GET /api/admin/analytics/abandon`, `GET /api/admin/analytics/cooccurrence`, `GET /api/admin/latency?window=`, CRUD สินค้า/ราคา
- warm-up โมเดล 10 ครั้งตอน start inference (instruction 4.5) — ทำแล้ว (10 ครั้งต่อรูปร่างภาพ 4:3 / 3:4 / 1:1)

### Phase 5 — ต่อ pipeline เข้ากับ inference

- frame queue ต่อรถเข็น (ยาว 2) → `inference.infer()` → บันทึก `t_infer_start_ms` / `t_infer_end_ms` จากผลของ client
- นับ `consecutive_errors` ของ client แล้วสร้าง alert `INFERENCE_DOWN` (ตอนนี้ `watchInference` แค่ log + ส่ง `inference_status` ไป `/ws/admin`)
- ตรวจว่า `result.model` ตรงกับโมเดล active ทุกเฟรม (กันช่วงที่กำลังสลับโมเดล)

### Phase 5 / 9 — การวัดผล (instruction ส่วนที่ 3)

- device ส่งทั้ง `rtt_ms` (ส่ง→ack) และ `e2e_ms` (ส่ง→`cart_update`) — มีคอลัมน์แล้วใน `frames`
- บันทึก `devices.camera_desc`, `app_version` และ `model_versions.imgsz` คู่กับการทดลองแต่ละรอบ
- load test script จำลอง N รถเข็น (1/5/10/20) ตาม instruction 3.4 — ต้องส่ง token ของ device ด้วย (brief หัวข้อ 5 ข้อ 2)

### ข้อเสนอที่ยังไม่ได้ตัดสินใจ

- คลาส `unknown_item` (instruction 4.4) — ต้อง train ใหม่ จึงอยู่นอกขอบเขตรอบนี้
- crop ROI บนมือถือก่อนส่ง (instruction 4.6 / brief หัวข้อ 9) — ทำเป็นตัวเลือก ค่าเริ่มปิด · จุดที่ต้องแก้มี comment ไว้แล้วใน `grab()` ของ `web/js/device.js` (server ต้องรู้ offset ของ crop ก่อน)

## สิ่งที่ต้องทำด้วยมือ (ระบบทำแทนไม่ได้)

| # | งาน | ทำไม | วิธี |
| --- | --- | --- | --- |
| 1 | ตั้ง `.env` | ตอนนี้ใช้ `ADMIN_PASSWORD` / `SESSION_SECRET` = `change-me` | `Copy-Item .env.example .env` แล้วแก้ |
| 2 | Wi-Fi เป็น Private + เปิด firewall | Wi-Fi ของเครื่องเป็น **Public** มือถือเข้าไม่ได้ · ต้องใช้สิทธิ์ Administrator | `scriptsirewall.ps1 -SetPrivate` (Run as administrator) — [phone-camera.md](phone-camera.md) |
| 3 | ติดตั้ง CA บนมือถือ | browser เปิดกล้องได้เฉพาะ HTTPS | `npm run lan-https` → สแกน QR → ติดตั้ง CA |
| 4 | วัดผลด้วยมือถือจริง (DoD Phase 5 + P2.8) | ส่ง 4 fps และ 30 fps, E2E p95 < 1 วินาที, ทิ้งเฟรม < 5% บน Wi-Fi จริงและผ่าน cloudflared · หมุนจอ 3:4 ↔ 4:3 แล้วกล่องยังตรง · Worker encoder บน Android / iOS (ยังไม่ได้ทดสอบกับมือถือจริง) | `npm run device-link -- A-07 --fps 30` แล้วใช้ 5 นาที · query ใน phone-camera.md |
| 5 | load test ซ้ำตอนปิดโปรแกรมที่ใช้ GPU | รอบแรกมี Roblox ใช้ GPU อยู่ ตัวเลขยังใช้ในบทที่ 4 ไม่ได้ | `npm run loadtest -- --carts 1,5,10,20 --seconds 60` — [pipeline.md](pipeline.md) |
| 6 | ตรวจค่าที่ผมตัดสินใจเอง | threshold ★ และตาราง attribute (จุดหยุดข้อ 3/6) | [presence-reasons.md](presence-reasons.md) หัวข้อ ⚠ |
| 7 | เติมข้อมูลสินค้า | ชื่อไทย 9 คลาสใหม่ (ร่างไว้), บาร์โค้ด Kirei ลาเวนเดอร์/พีช (ซ้ำกันใน xlsx), Babi Mild/Kirei ใช้แทนกันได้ไหม | แก้ `db/seed/products_master.csv` แล้ว `npm run db:seed` หรือแก้ในหน้า "สินค้าและราคา" |
| 8 | RQ4 บนข้อมูลจริง | ตัวเลขตอนนี้มาจาก scenario สังเคราะห์ | บันทึก session จริง + นับของจริงเอง → `npm run rq4 -- --session <id>` |
