# Data pipeline (real-time)

โค้ดอยู่ใน `server/src/pipeline/` แบ่งตาม stage ในหัวข้อ 5 ของ brief แต่ละโมดูลทดสอบแยกได้ (`server/test/pipeline.test.js`)

```text
มือถือ ──WS binary──▶ ingest ─▶ queue (2/คัน) ─▶ inference ─▶ postprocess ─▶ tracker ─▶ cart model ─▶ persist ─▶ publish
         ack ทันที ◀──┘                                                                                    ├▶ /ws/display  cart_update
                                                                                                           ├▶ /ws/admin    live_update, cart_event, ภาพ (watch)
                                                                                                           └▶ มือถือ        processed (วัด E2E)
```

| Stage | ไฟล์ | หน้าที่ |
| --- | --- | --- |
| 2 ingest | `ws/server.js` | ตรวจ token ของอุปกรณ์, `t_received_ms`, ตอบ `ack` ทันที |
| 2 queue | `pipeline/index.js` | คิวต่อรถเข็นยาว `FRAME_QUEUE_MAX`=2 ถ้าเต็มจะทิ้งเฟรมเก่าสุด (`frames.dropped=1`) |
| 3 inference | `pipeline/inferClient.js` | worker `INFER_CONCURRENCY`=1 เลือกเฟรมที่รอนานที่สุดข้ามทุกคัน, timeout 2 วินาที |
| 4 postprocess | `pipeline/postprocess.js` | `class_name` → `product_id`, `conf ≥ conf_threshold` ของโมเดล active, จุดศูนย์กลางอยู่ใน `carts.roi_polygon` |
| 5 tracker | `pipeline/tracker.js` | จำนวนนิ่งต่อคลาส + `local_track_id` (IoU) · `TRACKER_MODE` = `frame` / `window` / `bytetrack` |
| 6 cart model | `pipeline/cartModel.js` | ตอนนี้: จำนวนนิ่งเปลี่ยน = ADD/REMOVE · Phase 6 แทนด้วย presence + reason engine |
| 7 persist | `pipeline/writer.js`, `persist.js` | เฟรมที่มี event เขียนทันทีพร้อม event, `cart_item_history` (SCD2) และไฟล์ภาพ · เฟรมที่เหลือรวมเป็น transaction ทุก ~1 วินาที หรือทุก 200 แถว |
| 8 publish | `pipeline/index.js` | `cart_update` เมื่อรายการเปลี่ยน, `live_update` throttle 250 ms, ภาพ + กล่องเฉพาะ admin ที่ watch |
| 9 metrics | `routes/metrics.js` | มือถือส่ง `rtt_ms` / `e2e_ms` ที่วัดด้วยนาฬิกาตัวเอง → `frames` |

## กติกาที่สำคัญ

- **บันทึกเฉพาะตอนมี session:** รถเข็นที่ไม่มี session `active` จะไม่ถูก infer และไม่บันทึกอะไรเลย มือถือได้ `processed {idle:true}` ยกเว้นมี admin เปิด Live detail ของคันนั้นอยู่ ซึ่งจะ infer เพื่อแสดงภาพกับกล่อง (ใช้ตั้ง ROI) แต่ก็ไม่เขียน DB
- **session ใหม่เริ่มสถานะใหม่หมด:** สร้าง tracker และ cart model ใหม่, ล้าง ring buffer และสั่ง inference `resetTracks(cart)` ให้ ByteTrack เริ่มนับ ID ใหม่
- **ภาพเก็บไม่ทุกเฟรม:** ring buffer เก็บ 20 เฟรมล่าสุดต่อคันไว้ในหน่วยความจำ แล้วเขียนเป็นไฟล์ `data/frames/YYYYMMDD/{session}/{seq}.jpg` เฉพาะ 2 กรณี
  - เฟรมที่ทำให้เกิด event
  - ลูกค้ากด "รายการไม่ถูกต้อง": บันทึกเฟรมใน ring ของ session นั้นทั้งหมด และผูก `user_feedback.frame_id` กับเฟรมล่าสุด
- **ราคา:** snapshot ตอน ADD (`cart_item_history.unit_price`, `cart_events.unit_price`) ถ้าภายหลังมีการแก้ราคา ของที่อยู่ในรถเข็นแล้วไม่เปลี่ยนราคา

## Timestamp ใน `frames` (ใช้ใน `v_frame_latency`)

ทุกค่าเป็นเวลาของ server เครื่องเดียว ยกเว้น `t_capture_device_ms`, `rtt_ms` และ `e2e_ms` ซึ่งเป็นนาฬิกามือถือ และไม่เคยนำไปลบกับเวลา server

| คอลัมน์ | ความหมาย |
| --- | --- |
| `t_received_ms` | รับเฟรมจาก WebSocket |
| `t_infer_start_ms` / `t_infer_end_ms` | ส่ง / ได้คำตอบจาก inference (`queue_ms` = start − received) |
| `infer_ms` | เวลาที่ Python รายงาน (preprocess + model + NMS) |
| `t_tracker_ms` | postprocess + tracker เสร็จ |
| `t_db_ms` | ขั้น persist เสร็จ: เฟรมที่มี event คือหลัง commit ส่วนเฟรมทั่วไปคือหลังเข้าคิว batch (แถวจะถูก commit ภายใน 1 วินาทีถัดไป) |
| `t_pushed_ms` | ส่ง `cart_update` / `live_update` / `processed` แล้ว |
| `rtt_ms` / `e2e_ms` | มือถือ: ส่ง → `ack` / ส่ง → `processed` |

## Alert ที่ pipeline สร้าง

| Alert | เมื่อไร |
| --- | --- |
| `INFERENCE_DOWN` | inference ล้มติดกัน `INFERENCE_DOWN_AFTER`=5 เฟรม (สร้างครั้งเดียวจนกว่าจะกลับมา และส่ง `inference_status`) |
| `DISCONNECTED` | มี session แต่ไม่มีเฟรมเกิน `DISCONNECT_MS`=30 วินาที |
| `HIGH_LATENCY` | p95 ของ server (received → pushed) ใน 100 เฟรมล่าสุดเกิน `HIGH_LATENCY_MS`=300 ms (ไม่เกิน 1 ครั้งต่อ 5 นาทีต่อคัน) |

## Load test (instruction 3.4)

`npm run loadtest` จำลองมือถือ N เครื่อง ใช้กติกาเดียวกับ `device.html` คือส่งเฟรมถัดไปเมื่อได้ ack ของเฟรมก่อนแล้ว และไม่เกิน fps ที่ตั้งไว้ ภาพที่ใช้คือ `server/test/fixtures/frames/*.jpg` (640×480 q70 ย่อจากภาพ prototype) แต่ละคันมี session ของตัวเอง ผลบันทึกที่ `exports/loadtest/`

```powershell
$env:DB_PATH="db/loadtest.db"; npm run dev          # แยกฐานข้อมูลทดสอบออกจาก smartcart.db
$env:DB_PATH="db/loadtest.db"; npm run loadtest -- --carts 1,5,10 --fps 4 --seconds 60
```

### ผลรอบแรก (2026-11-03, localhost, RTX 3050 Laptop, yolo11s, 4 fps, 20 วินาที)

> ⚠ ระหว่างวัดมีโปรแกรมอื่นใช้ GPU อยู่ (`RobloxPlayerBeta.exe`) inference ค้างเกิน 2 วินาทีเป็นพัก ๆ ทำให้เกิด timeout และเฟรมถูกทิ้งเป็นช่วง ๆ **ต้องวัดซ้ำหลังปิดโปรแกรมที่ใช้ GPU** ก่อนนำไปใช้ในบทที่ 4 และตัวเลขนี้ยังไม่รวม Wi-Fi

| รถเข็น | fps/คัน | เฟรมถูกทิ้ง | E2E p50 / p95 (ms) | queue p95 | server p95 |
| --- | --- | --- | --- | --- | --- |
| 1 | 3.9 | 9.1 % (ช่วงที่ GPU ค้าง 1 ครั้ง) | 28 / 97 | 2 | 82 |
| 5 | 3.9 | 21.3 % | 91 / 219 | 175 | 217 |
| 10 | 3.9 | 27.7 % | 441 / 558 | 516 | 557 |

- **1 คัน:** ช่วงที่ไม่ค้าง E2E ราว 20–40 ms และไม่มีเฟรมถูกทิ้ง เฟรมที่ถูกทิ้งทั้งหมด (seq 54–61) เกิดหลัง inference ค้างครั้งเดียว 2 วินาที (seq 53 timeout)
- **5–10 คัน:** 20–40 เฟรม/วินาที ใกล้ความสามารถของ GPU รุ่นนี้ (~25 ms/เฟรม) คิวจึงยาวและต้องทิ้งเฟรม ซึ่งเป็นพฤติกรรมที่ออกแบบไว้ (เก็บเฟรมใหม่ ทิ้งเฟรมเก่า)
- ลอง `INFER_CONCURRENCY=2` แล้วผลไม่ดีขึ้นชัดเจน (ยังแย่ง GPU) จึงคงค่าเริ่มต้นไว้ที่ 1 ตาม brief

DoD ของ Phase 5 กำหนด "E2E p95 < 1 วินาที, เฟรมถูกทิ้ง < 5%" สำหรับมือถือจริงบน Wi-Fi รถเข็นละ 1 เครื่อง ซึ่งต้องวัดด้วยมือถือจริงตาม `docs/phone-camera.md`
