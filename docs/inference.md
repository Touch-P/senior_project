# Inference service และโหมด mock

Node.js เรียก inference ผ่าน interface เดียว (`server/src/pipeline/inferClient.js`) ซึ่งมี 2 โหมด เลือกด้วย `INFERENCE_MODE` ใน `.env`

| โหมด | ทำงานอย่างไร | ใช้เมื่อ |
| --- | --- | --- |
| `real` | HTTP ไป Python service `inference/app.py` (FastAPI + Ultralytics) | เครื่องที่มี weights และ GPU |
| `mock` | เล่น scenario ของกล่อง detection จาก `server/test/scenarios/*.json` ต่อรถเข็น ไม่ต้องมี Python หรือ GPU | demo สำรองวันสอบ, เครื่องที่ไม่มี GPU, test |

Python ทำ inference อย่างเดียว ส่วนการเขียนฐานข้อมูลและ logic ทั้งหมดอยู่ใน Node.js

## ติดตั้งและรัน (โหมด real)

```powershell
cd inference
uv sync                 # ครั้งแรก: Python 3.11 + torch 2.11 CUDA 12.8 (~2.5 GB) ตาม uv.lock
cd ..
npm run inference       # เปิดค้างไว้อีกหน้าต่าง → http://127.0.0.1:8001
npm run dev             # server จะสั่ง inference ให้โหลดโมเดลที่ active ใน DB
npm run infer:probe     # ส่งภาพ web/assets/camera/*.jpg ผ่าน client ตัวเดียวกับ server แล้วแสดงผล
npm run inference:test  # pytest กับ weights จริง
```

- ใช้รุ่นเดียวกับที่ใช้ benchmark ใน `SNP/experiment.yaml`: `ultralytics==8.4.188`, `torch==2.11.0+cu128`
- service bind `127.0.0.1` เท่านั้น เครื่องอื่นใน LAN จึงเรียกตรงไม่ได้ ต้องผ่าน Node.js
- `MODEL_PATH` คือ weights ที่โหลดตอน start หลังจากนั้น Node.js จะสั่งสลับไปเป็นโมเดลที่ active ใน `model_versions` เอง (DB เป็นตัวตั้ง)
- weights ทุกไฟล์เปิดแบบอ่านอย่างเดียว ไม่มีการเขียนไฟล์ใด ๆ ใน `SNP`

| ตัวแปร (`.env`) | ค่าเริ่ม | ใช้โดย |
| --- | --- | --- |
| `INFERENCE_MODE` | `real` | Node |
| `INFERENCE_URL` | `http://127.0.0.1:8001` | ทั้งคู่ (Python ใช้แค่ port) |
| `INFERENCE_TIMEOUT_MS` | `2000` | Node: timeout ต่อเฟรม |
| `MODEL_PATH` | `<repo>/models/v11/best.pt` | Python |
| `MODEL_NAME` | ว่าง = `model_name-run_date` จาก `*-test-metrics.json` ข้าง weights (เช่น `yolo11s-20261104`) | Python: ชื่อที่ `/health` รายงาน ต้องตรงกับ `model_versions.name` |
| `WEIGHTS_ROOT` | `<repo>/models` | ทั้งคู่: `model_versions.weights_path` อ้างจากที่นี่ และ `POST /model` โหลดได้เฉพาะไฟล์ใต้โฟลเดอร์นี้ |
| `INFER_DEVICE` | `auto` (`cuda:0` ถ้ามี) | Python |
| `INFER_IMGSZ` | `640` | Python |
| `INFER_CONF` | `0.25` | Python: conf ขั้นต่ำที่ส่งกลับ (Node กรองจริงด้วย `conf_threshold` ของโมเดล) |
| `MOCK_SCENARIO` | ว่าง | Node: บังคับทุกรถเข็นใช้ scenario นี้ |
| `MOCK_LATENCY_MS` | `0` | Node: หน่วงเวลาจำลองต่อเฟรม |

## Endpoint ของ Python service

| Method | Path | ทำอะไร |
| --- | --- | --- |
| GET | `/health` | `model`, `names` (ตามลำดับ class id), `nc`, `device`, `warmup_ms`, versions |
| POST | `/infer?cart_id=&seq=&track=` | body เป็น JPEG ดิบ (`content-type: image/jpeg`) หรือ multipart field `image` |
| POST | `/model` | `{"path": "...", "name": "..."}` โหลด weights ใหม่ + warm-up แล้วค่อยสลับ ถ้าโหลดไม่ได้ยังใช้ตัวเดิม |
| DELETE | `/tracks/{cart_id}` | ลบสถานะ ByteTrack ของรถเข็น (เริ่ม session ใหม่) |

ผลของ `POST /infer` พิกัด normalize 0–1 ตาม brief หัวข้อ 4:

```json
{
  "detections": [
    { "class_name": "bengbeng_pack12", "class_id": 0, "conf": 0.9438,
      "x1": 0.35313, "y1": 0.24271, "x2": 0.53906, "y2": 0.4724, "track_id": 1 }
  ],
  "model": "yolo11s-20261104", "infer_ms": 12.7,
  "speed": { "preprocess": 1.2, "inference": 9.8, "postprocess": 1.7 },
  "w": 640, "h": 480, "cart_id": "A-08", "seq": 41, "decode_ms": 1.3
}
```

- `track_id` มีเฉพาะเมื่อส่ง `track=true` (tracker โหมด (c) ของ RQ4) และเป็น `null` ถ้า ByteTrack ยังไม่ยืนยันกล่องนั้น
- สถานะ ByteTrack แยกต่อ `cart_id` โดย ID เริ่มนับใหม่ของแต่ละรถเข็น และลบเองเมื่อไม่ได้ใช้ 60 วินาที (`TRACK_IDLE_MS`)
- Node ฝั่ง client แปลง error เป็น code: `INFERENCE_DOWN`, `INFERENCE_TIMEOUT`, `INFERENCE_BAD_RESPONSE` (รูปแบบผิด), `INFERENCE_REJECTED` (4xx เช่นภาพเสีย)

### Warm-up

ทุก predict วิ่งบน **GPU thread เดียว** (`GPU_THREAD`) ที่ warm ตอนเริ่มและหลังสลับโมเดล เพราะ predict ครั้งแรกบน thread ใหม่ใช้ ~1.55 วินาที (ตั้งค่า CUDA ต่อ thread) ซึ่งเดิมทำให้เฟรมแรกของทุก session ค้าง — รายละเอียดใน [pipeline.md](pipeline.md) หัวข้อ 30 fps

Warm-up 10 ครั้ง **ต่อรูปร่างภาพ** ได้แก่ แนวนอน 4:3, แนวตั้ง 3:4 และจัตุรัส เพราะ letterbox คงสัดส่วนภาพไว้ ภาพแต่ละรูปร่างจึงเป็น tensor คนละขนาด และ cuDNN จะจูนใหม่ตอนเจอขนาดใหม่ครั้งแรก ตอนแรกที่ warm-up เฉพาะ 640×640 เฟรมจริงเฟรมแรก (4:3) ใช้เวลา **2,087 ms** เกิน timeout 2 วินาที หลังแก้เหลือ **48 ms**

## โมเดลที่ inference โหลดได้

ทดสอบด้วย `POST /model` กับ weights ทั้ง 3 ชุดใน `models/` (อ่านอย่างเดียว) — ทุกชุดโหลดได้ด้วย Ultralytics และรายงาน 20 คลาสตรงกับ `per_class` ในไฟล์ metrics:

| โมเดล | weights | ผล |
| --- | --- | --- |
| yolo11s-20261104 (active ตั้งต้น) | `models/v11/best.pt` | โหลดได้ |
| yolo26s-20261104 | `models/v26/best.pt` | โหลดได้ |
| yolov9s-20261104 | `models/v9/best.pt` | โหลดได้ |

`POST /api/admin/models/:name/activate` สั่งโหลดก่อน แล้วค่อยเปลี่ยน `is_active` ใน DB เฉพาะเมื่อโหลดสำเร็จ จึงไม่มีทางที่โมเดลซึ่งรันไม่ได้จะกลายเป็น active weights ที่ Ultralytics โหลดไม่ได้จะได้ `MODEL_LOAD_FAILED` และโมเดลเดิมยังทำงานต่อ

class names ของโมเดล active ถูกอ่านจาก weights ที่โหลดจริงแล้วเขียนลง `model_versions.class_names` และ `products.in_model` ทุกครั้ง ดังนั้นเมื่อมี weights 20 คลาส แค่เพิ่มแถวใน `model_versions` แล้ว activate ระบบก็ทำงานต่อได้โดยไม่ต้องแก้โค้ด

## ความปลอดภัยของ Ultralytics

`inference/app.py` ตั้งค่าเหล่านี้ก่อน import ultralytics:

| ค่า | เหตุผล |
| --- | --- |
| `YOLO_AUTOINSTALL=false` | ถ้า checkpoint อ้าง module ที่ไม่มี Ultralytics จะ `pip install` package ชื่อนั้นจาก PyPI ให้เองตอนรัน ระหว่างทดสอบเกิดขึ้นจริง: โหลด weights ของ YOLOv6 แล้วมันติดตั้ง `yolov6==0.0.1` จาก PyPI ซึ่งไม่ใช่ repo ที่ใช้ train และไม่มีใครตรวจว่าเป็นของใคร (`uv sync` ลบออกแล้ว) หลังตั้งค่านี้ การโหลดแบบนั้นจะล้มด้วย `MODEL_LOAD_FAILED` แทน |
| `YOLO_OFFLINE=true` | ปิด online check, การดาวน์โหลด asset และ usage telemetry (ร้านอยู่ใน LAN) |
| `YOLO_CONFIG_DIR=inference/.ultralytics` | เก็บ `settings.json` ใน repo (gitignored) แทน `%APPDATA%` และตั้ง `sync=false` |

`.pt` ของ PyTorch เป็น pickle ซึ่งรันโค้ดได้ตอนโหลด จึงจำกัดให้ `POST /model` โหลดได้เฉพาะไฟล์ใต้ `WEIGHTS_ROOT` และ service ฟังแค่ `127.0.0.1`

## Latency ที่วัดได้ (RTX 3050 Laptop 4 GB, yolo11s FP16)

| ภาพ | infer p50 / p95 | round trip Node → Python → Node p50 / p95 |
| --- | --- | --- |
| 640×480 JPEG q70 (ขนาดที่มือถือจะส่ง) ×200 | 12.7 / 20.0 ms | 17.0 / 24.8 ms |
| เดียวกัน + `track=true` ×200 | 13.2 / 22.0 ms | 18.7 / 28.7 ms |
| 1600×1200 (ภาพ prototype) ×180 | 14.9 / 25.0 ms | 31.0 / 52.6 ms |

ตัวเลขนี้ยังไม่รวมเวลาส่งผ่าน Wi-Fi จากมือถือ ซึ่งจะวัดใน Phase 5 (`rtt_ms`, `e2e_ms`) วัดซ้ำได้ด้วย `npm run infer:probe -- <ภาพ> --repeat 200 -q [--track]`

### ผลบนภาพของ prototype

`web/assets/camera/*.jpg` ตรงกับ `data.js` 4 ภาพจาก 6 ภาพ อีก 2 ภาพโมเดลทายเป็นคลาสคู่ที่สับสนบ่อยตาม brief 7.3:

| ภาพ (รถเข็น) | `data.js` | yolo11s จริง |
| --- | --- | --- |
| img-1 (A-03) | `lay_big_ori` 0.91 + `lay_party_ori` 0.58 | `lay_party_ori` 0.96 + `lay_party_ori` 0.91 |
| img-941 (B-03) | `mama_cup_ok_hotKR` 0.93 | `mama_cup_ok_cheeseGo` 0.94 |

กรณีนี้เป็นตัวอย่างจริงที่ใช้ทดสอบ `MODEL_FLIP` ใน Phase 6 ได้ ส่วน scenario ของโหมด mock ยังยึด `data.js` เพื่อให้ demo เหมือน prototype

## โหมด mock และ scenario

- แต่ละรถเข็นมี cursor ของตัวเอง เฟรมที่ส่งเข้ามา 1 เฟรมจะเลื่อน scenario ไป 1 เฟรม และเมื่อเล่นจนจบจะวนกลับไปเริ่มใหม่ (`loop`)
- การเลือก scenario เรียงตามลำดับ: `MOCK_SCENARIO` → scenario ที่ `cart` ตรงกับรถเข็น → scenario ที่ `default: true` (A-08)
- `resetTracks(cart)` (เริ่ม session ใหม่) จะเริ่ม scenario ของรถเข็นนั้นจากเฟรมแรก
- `track=true` คืน `track_id` จาก `id` ของวัตถุใน scenario ทำให้ test ของ tracker โหมด (c) รันได้โดยไม่ต้องมี GPU

`npm run scenarios` สร้าง `cart-*.json` จาก `web/data.js` (`CARTS[].boxes`, `outside`, `events`) โดยลำดับคือ ตะกร้าว่าง → สินค้าเลื่อนเข้าทางขอบล่างทีละชิ้นตามลำดับ event → ค้างตะกร้าสุดท้าย → หยิบออกทางขอบล่าง ของ A-08 มี `lay_big_nori` เข้าแล้วออก (abandon) ตาม event log ส่วน A-03 มีกล่อง `lay_big_ori` นอก ROI

รูปแบบไฟล์ (Phase 6 ใช้รูปแบบเดียวกันเขียน scenario ของ test 12 สถานการณ์ในหัวข้อ 7.7 โดยใช้ชื่อไฟล์อื่นที่ไม่ขึ้นต้นด้วย `cart-`):

```json
{
  "name": "brand-switch", "description": "...", "cart": "A-08", "default": false,
  "fps": 5, "loop": false, "jitter": 0.003, "seed": 1, "infer_ms": 14,
  "timeline": [
    { "frames": 10, "note": "empty", "objects": [] },
    { "frames": 4, "note": "ADD lay_big_ori", "objects": [
      { "id": "a", "class_name": "lay_big_ori", "conf": 0.93,
        "box": [0.3, 0.5, 0.5, 0.9], "from": [0.3, 1.25, 0.5, 1.65] } ] }
  ],
  "expect": { "reasons": ["BRAND_SWITCH"] }
}
```

- `box` คือตำแหน่งตอนจบ segment ส่วน `from` (ไม่ใส่ก็ได้) คือตอนเริ่ม ระหว่างนั้นเลื่อนแบบเส้นตรง ส่วนที่ล้นขอบภาพจะถูกตัด ถ้าล้นทั้งกล่องจะไม่ปรากฏ
- `id` เดียวกันข้าม segment คือของชิ้นเดียวกัน
- `jitter` คือ noise ของพิกัดที่สุ่มแบบกำหนด seed ทำให้เล่นซ้ำกี่ครั้งก็ได้ผลเหมือนเดิม
