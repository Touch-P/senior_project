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
| 2 ingest | `ws/server.js` | ตรวจ token ของอุปกรณ์, `t_received_ms`, ตอบ `ack` ทันที · ขนาดภาพจริงอ่านจาก JPEG (`pipeline/jpeg.js`) ไม่เชื่อ header |
| 2 queue | `pipeline/index.js` | คิวต่อรถเข็นยาว `FRAME_QUEUE_MAX`=2 ถ้าเต็มจะทิ้งเฟรมเก่าสุด (`frames.dropped=1`) |
| 3 inference | `pipeline/inferClient.js` | worker `INFER_CONCURRENCY`=1 เลือกเฟรมที่รอนานที่สุดข้ามทุกคัน, timeout 2 วินาที · ฝั่ง Python ทุก predict วิ่งบน GPU thread เดียวที่ warm ไว้ (ดูด้านล่าง) |
| 4 postprocess | `pipeline/postprocess.js` | `class_name` → `product_id`, `conf ≥ conf_threshold` ของโมเดล active, จุดศูนย์กลางอยู่ใน `carts.roi_polygon` |
| 5 tracker | `pipeline/tracker.js` | จำนวนนิ่งต่อคลาส + `local_track_id` (IoU) · `TRACKER_MODE` = `frame` / `window` / `bytetrack` · W/K สเกลตาม fps จริงของรถเข็น (ดูด้านล่าง) |
| 6 cart model | `pipeline/cartModel.js` | ตอนนี้: จำนวนนิ่งเปลี่ยน = ADD/REMOVE · Phase 6 แทนด้วย presence + reason engine |
| 7 persist | `pipeline/writer.js`, `persist.js` | เฟรมที่มี event เขียนทันทีพร้อม event, `cart_item_history` (SCD2) และไฟล์ภาพ · เฟรมที่เหลือรวมเป็น transaction ทุก ~1 วินาที หรือทุก 200 แถว |
| 8 publish | `pipeline/index.js` | `cart_update` เมื่อรายการเปลี่ยน, `live_update` throttle 250 ms, ภาพ + กล่องเฉพาะ admin ที่ watch |
| 9 metrics | `routes/metrics.js` | มือถือส่ง `rtt_ms` / `e2e_ms` ที่วัดด้วยนาฬิกาตัวเอง → `frames` |

## กติกาที่สำคัญ

- **บันทึกเฉพาะตอนมี session:** รถเข็นที่ไม่มี session `active` จะไม่ถูก infer และไม่บันทึกอะไรเลย มือถือได้ `processed {idle:true}` ยกเว้นมี admin เปิด Live detail ของคันนั้นอยู่ ซึ่งจะ infer เพื่อแสดงภาพกับกล่อง (ใช้ตั้ง ROI) แต่ก็ไม่เขียน DB
- **session ใหม่เริ่มสถานะใหม่หมด:** สร้าง tracker และ cart model ใหม่, ล้าง ring buffer และสั่ง inference `resetTracks(cart)` ให้ ByteTrack เริ่มนับ ID ใหม่
- **ภาพเก็บไม่ทุกเฟรม:** ring buffer เก็บภาพ **5 วินาทีล่าสุด** ต่อคันไว้ในหน่วยความจำ (อย่างน้อย 20 เฟรม ไม่เกิน 200 = เท่าเดิมที่ 4 fps, ~150 เฟรมที่ 30 fps; เดิม 20 เฟรมคงที่ = แค่ 0.67 วินาทีที่ 30 fps) แล้วเขียนเป็นไฟล์ `data/frames/YYYYMMDD/{session}/{seq}.jpg` เฉพาะ 2 กรณี
  - เฟรมที่ทำให้เกิด event
  - ลูกค้ากด "รายการไม่ถูกต้อง": บันทึกเฟรมใน ring ของ session นั้น — ถ้าเกิน 20 เฟรม เลือก 20 เฟรมกระจายทั่ว 5 วินาที (มีเฟรมแรกและล่าสุดเสมอ) — และผูก `user_feedback.frame_id` กับเฟรมล่าสุด
- **ราคา:** snapshot ตอน ADD (`cart_item_history.unit_price`, `cart_events.unit_price`) ถ้าภายหลังมีการแก้ราคา ของที่อยู่ในรถเข็นแล้วไม่เปลี่ยนราคา

## 30 fps ต่อคัน (P2.8)

### tracker / presence นับเป็นวินาที

W=8, K=3 (REMOVE หลัง 2W) ตั้งไว้ที่ ~4 fps = หน้าต่าง ~2 วินาที, ADD ~0.75 วินาที, REMOVE ~4 วินาที ถ้าใช้จำนวนเฟรมเดิมที่ 30 fps หน้าต่างจะเหลือ 0.27 วินาที ADD/REMOVE จะกระตุก

- tracker วัด fps ของเฟรมที่ **ผ่าน inference จริง** ของรถเข็นนั้น (median ช่วงห่างระหว่างเฟรมใน 2 วินาที หลังมีเฟรมครบ 1 วินาที; ก่อนหน้านั้นใช้ fps ที่มือถือบอกใน `hello`) แล้วคูณทุกจำนวนเฟรมด้วย `scale = fps / TRACKER_REF_FPS` (ค่าเริ่ม 4) มี hysteresis 20%
- ต่ำกว่า 6 fps `scale = 1` พอดี → 2-5 fps (รวม 4 fps) ทำงานเหมือนเดิมทุกเฟรม · 30 fps: `scale = 7.5` → W=60 (2.0 วินาที), K=23 (0.77 วินาที), REMOVE หลัง 120 เฟรม (4.0 วินาที)
- presence engine ใช้ scale เดียวกันกับ 2W / 4W / occludeAfter และเทียบตำแหน่งทุก `round(scale)` เฟรม (หลักฐานเคลื่อนเข้า/ออกขอบ ROI จึงดูช่วง ~250 ms เท่าเดิม) · `flipWindowMs`, `correctionMs`, การจับคู่เหตุผล เป็นเวลาอยู่แล้ว
- ทดสอบ: `server/test/tracker-fps.test.js` — 4 fps ที่มีเวลาให้ผลเท่าแบบไม่มีเวลาทุกเฟรม, ADD/flicker/REMOVE ที่ 30 fps, scenario RQ4 ทั้ง 18 ชุดที่ 30 fps (window + bytetrack) · `npm run rq4` ที่ fps เดิมได้ CSV รายชุด **เหมือนก่อนแก้ทุกบรรทัด**
- `npm run rq4 -- --fps 30` สร้าง scenario เดิมใหม่ที่ 30 fps (การเคลื่อนที่เดิม, jitter ต่อเฟรม) ได้ b-window 100% / c-bytetrack 100% เท่ากับที่ 10, 15, 20, 25 fps · W/K อ้าง fps ของ scenario เอง (scenario `cart-*` อัดที่ 5 fps); `--ref-fps 4` บังคับเวลาแบบ 4 fps แล้ว `cart-*` 6 ชุดไม่ผ่าน เพราะ REMOVE ช่วงท้ายต้องใช้ ~4 วินาที แต่ scenario เหลือไม่ถึง — ผลเดียวกับการเล่น scenario 5 fps นั้นที่ 4 fps ด้วยโค้ดเดิม

### ฝั่ง server ที่ 30 fps

| ค่า | ที่ 30 fps | ผล |
| --- | --- | --- |
| `FRAME_QUEUE_MAX`=2 (ทิ้งเฟรมเก่า) | เหมาะ: inference ~20 ms < 33 ms ต่อเฟรม คิวแทบไม่ยาว (queue p95 1 ms) ถ้า GPU ไม่ทันเฟรมเก่าถูกทิ้งตามที่ออกแบบ | คงไว้ |
| `INFER_CONCURRENCY`=1 | 1 คันใช้ GPU ~60% · 2 คันยังทัน · 3 คันเกินเพดาน (~60 เฟรม/วินาทีรวม) | คงไว้ |
| timeout 2 วินาที | ไกลจากเวลาจริง (p95 ~21 ms) | คงไว้ |
| ring buffer 20 เฟรม | = 0.67 วินาที ไม่พอเป็นหลักฐาน | **เปลี่ยนเป็น 5 วินาที** (ข้างบน) |
| writer batch (~1 วินาที / 200 แถว) | 30 แถว frames + detections ต่อวินาทีต่อคัน = 1 transaction/วินาที ไม่เคยถึง 200 | คงไว้ · แต่ `frames` โต ~108,000 แถว/ชั่วโมง/คัน ที่ 30 fps (4 fps ~14,400) — retention 30 วันยังลบตามเดิม ควรดูขนาด DB ถ้าใช้ 30 fps นาน |
| `live_update` 250 ms / ภาพ watch 250 ms / `latest.jpg` | throttle อยู่แล้ว (admin ได้ ~4 ภาพ/วินาที) | คงไว้ |
| `HIGH_LATENCY` (100 เฟรมล่าสุด) | = ~3 วินาทีที่ 30 fps | คงไว้ |

### GPU thread เดียว (แก้เฟรมแรกของทุก session ค้าง 1.6 วินาที)

วัดตอนทดสอบ 30 fps: predict ครั้งแรกบน thread ใหม่ใช้ ~1.55 วินาที (ตั้งค่า CUDA ต่อ thread) บน thread เดิม 11-62 ms · FastAPI ส่ง `/infer` ไป thread ใหม่ได้ (เช่น ตอนเริ่ม session ที่ `DELETE /tracks` มาพร้อมเฟรมแรก) เฟรมแรกของทุก session จึงค้าง ~1.6 วินาทีและคิวทิ้งเฟรมที่ตามมา (ทดสอบ 4 วินาทีที่ 4 fps ทิ้ง 25%) — ปัญหานี้มีอยู่ก่อนแล้ว ตอนนี้ `inference/app.py` รันทุก predict บน executor thread เดียว warm ตอนเริ่ม (และหลังสลับโมเดล) ทั้งภาพ 4:3, 3:4, 1:1 → ทิ้ง 0%

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

`npm run loadtest` จำลองมือถือ N เครื่อง ใช้กติกาเดียวกับ `device.html` คือนาฬิกา fps ที่ไม่สะสมการเลื่อน, มีเฟรมรอ ack ได้ไม่เกิน `--inflight` (ค่าเริ่ม 8; `1` = แบบเดิมรอ ack ทีละเฟรม) และข้ามเฟรมเมื่อ buffer > 512 KB · `--delay-ms` จำลองความหน่วงทางเดียวของเน็ต (RTT = 2 เท่า) ภาพที่ใช้คือ `server/test/fixtures/frames/*.jpg` (640×480 q70 ย่อจากภาพ prototype) แต่ละคันมี session ของตัวเอง ผลบันทึกที่ `exports/loadtest/`

```powershell
$env:DB_PATH="db/loadtest.db"; npm run dev          # แยกฐานข้อมูลทดสอบออกจาก smartcart.db
$env:DB_PATH="db/loadtest.db"; npm run loadtest -- --carts 1,5,10 --fps 4 --seconds 60
```

### ผล 30 fps (2026-11-04, localhost, RTX 3050 Laptop, yolo11s, ไม่มีโปรแกรมอื่นใช้ GPU)

`DB_PATH=db/loadtest.db` · `npm run loadtest -- --carts 1 --fps 30 --seconds 30` (หลังแก้ทั้งหมด) · fps = ที่ส่งจริงต่อคัน, inferred = เฟรมที่ได้ผลต่อวินาที

| รถเข็น × fps | หน้าต่าง | RTT จำลอง | fps ส่งจริง | inferred | เฟรมถูกทิ้ง | E2E p50 / p95 (ms) | queue p95 | infer p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **1 × 30** | 8 | – | **30.0** | 30.0 | **0.1 %** | **19.5 / 22.2** | **1** | 21 |
| 1 × 30 | 1 (เดิม) | – | 30.0 | 30.0 | 0.1 % | 19.0 / 23.0 | 1 | 22 |
| 1 × 30 | 1 (เดิม) | ~217 ms | 4.3 | 4.3 | 0 % | 284 / 297 | 1 | 71 |
| 1 × 30 | 6 | ~217 ms | 25.8 | 25.7 | 0.4 % | 233 / 241 | 6 | 23 |
| 1 × 30 | 8 | ~217 ms | 30.1 | 30.0 | 0.2 % | 233 / 240 | 1 | 21 |
| 1 × 30 | 8 | ~312 ms | 24.1 | 24.1 | 0.2 % | 329 / 342 | 1 | 22 |
| 2 × 30 | 6 | – | 30.0 | 29.9 | 0.4 % | 21.9 / 35.4 | 19 | 19 |
| 3 × 30 | 6 | – | 30.0 | 23.5 | 21.6 % | 68.2 / 85.5 | 70 | 18 |
| 1 × 4 | 6 | – | 4.0 | 4.0 | 0 % | 70.1 / 75.0 | 1 | 72 |

- inference ทำ 30 fps ได้บนเครื่องนี้สำหรับ 1-2 คัน จึงไม่ต้องใช้ "infer ทุก N เฟรม" · 3 คันขึ้นไปเกินเพดาน GPU (~60 เฟรม/วินาทีรวม) เฟรมเก่าถูกทิ้งตามที่ออกแบบ
- ที่ 4 fps เวลา inference **สูงกว่า** ที่ 30 fps (~70 vs ~21 ms) เพราะ GPU laptop อยู่สถานะประหยัดพลังงาน (P8, 315 MHz) เมื่องานเบา — ไม่ใช่ปัญหาของโค้ด แต่ทำให้ตัวเลข 4 fps รอบนี้ต่างจากรอบแรก
- ตัวเลขทั้งหมดเป็น localhost ยังไม่รวม Wi-Fi / tunnel จริง; แถว RTT จำลองหน่วงเวลาใน client เท่านั้น (ไม่จำลอง bandwidth หรือ packet loss)

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
