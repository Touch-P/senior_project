# Smart Cart

รถเข็นอัจฉริยะที่ใช้กล้องมองลงในตะกร้าและโมเดล YOLO ตรวจจับสินค้า เพื่อแสดงรายการและราคารวมให้ลูกค้าแบบ real-time โดยไม่ต้องสแกนบาร์โค้ด พร้อม dashboard ให้ผู้ดูแลดูรถเข็นสดและวิเคราะห์พฤติกรรมการหยิบสินค้าเข้า–ออก

Senior project ภาค 2 · โมเดลที่ใช้ใน prototype: `yolo11s-s0-20261025` (mAP50-95 0.916)

## ความต้องการของเครื่อง

- **Node.js 22 ขึ้นไป** (กำหนดใน `package.json` → `engines.node: ">=22"` เพราะ better-sqlite3 13 รองรับตั้งแต่ Node 22) — ทดสอบแล้วบน Node 24
- ไม่ต้องติดตั้ง Visual Studio / build tools
- ตรวจเครื่องได้ด้วย `npm run doctor`

## เปิด prototype (ไม่ต้องมี backend)

```powershell
npx serve web      # แล้วเปิด /?mock=1 (หรือดับเบิลคลิก web/index.html ก็ได้)
```

ไม่มี server ตอบ `/api` หน้าเว็บจะสลับเป็นข้อมูลจำลองเอง ไม่ต้องใส่ `?mock=1` ก็ได้

แล้วเปิด URL ที่ terminal แสดง (ปกติคือ `http://localhost:3000`)

- หน้าลูกค้า: `#/` (แสดงผลดีที่สุดบนจอกว้าง จะมีแผงจำลอง real-time ด้านขวา)
- หน้า admin: `#/a/login` · บัญชีทดลอง `admin@smartcart.co.th` / `admin1234` และ `staff@smartcart.co.th` / `staff1234` (เป็นรหัสปลอมของ prototype เท่านั้น)

## ติดตั้ง backend และฐานข้อมูล

```powershell
Copy-Item .env.example .env   # แล้วแก้ ADMIN_PASSWORD และ SESSION_SECRET
npm install
npm run doctor                # ตรวจ Node, native module, เขียน SQLite จริง, .env, migration
npm run db:init               # สร้าง db/smartcart.db จาก db/migrations
npm run db:seed               # สินค้า 20 รายการ, รถเข็น, โมเดล, บัญชี admin
npm test
```

รายละเอียด schema และ ER diagram: [docs/database.md](docs/database.md)

## รัน server

```powershell
npm run dev        # รีสตาร์ทเองเมื่อแก้โค้ด · หรือ npm start
```

### Inference (โมเดล YOLO)

```powershell
cd inference; uv sync; cd ..   # ครั้งแรกครั้งเดียว: Python 3.11 + torch CUDA (~2.5 GB)
npm run inference              # เปิดค้างไว้อีกหน้าต่าง (http://127.0.0.1:8001)
npm run infer:probe            # ลองส่งภาพตัวอย่างผ่าน client ของ server
```

### มือถือเป็นกล้องรถเข็น

```powershell
npm run lan-https              # ครั้งแรก: cert สำหรับ IP ของ Wi-Fi (+ ติดตั้ง CA บนมือถือ, เปิด firewall ด้วยสิทธิ์ admin)
npm run device-link -- A-07    # QR ของหน้า device.html สำหรับรถเข็น A-07
```

หรือในหน้า Admin › Live กด **เพิ่ม device (กล้องมือถือ)** จะได้ QR เดียวกันบนจอ มือถือสแกนแล้วกด "เริ่มส่งภาพ" การ์ดของรถเข็นนั้นจะแสดงภาพสด ไม่มี cert ใช้ได้ผ่าน cloudflared tunnel (ดู docs/phone-camera.md)

ขั้นตอนเต็ม, การติดตั้ง CA บน Android/iOS และวิธีแก้ปัญหา: [docs/phone-camera.md](docs/phone-camera.md) · pipeline และ load test: [docs/pipeline.md](docs/pipeline.md)

ไม่มี GPU หรือไม่อยากรัน Python: ตั้ง `INFERENCE_MODE=mock` ใน `.env` แล้ว server จะเล่น scenario จาก `server/test/scenarios/` (สร้างจาก `web/data.js` ด้วย `npm run scenarios`) รายละเอียด โมเดลที่โหลดได้ และ latency ที่วัดได้: [docs/inference.md](docs/inference.md)

- ยังไม่มี cert (มาใน Phase 5): server รัน **HTTP เฉพาะ `http://localhost:8443`** ในโหมด development มือถือยังเข้าไม่ได้
- มี `certs/lan.pem` + `certs/lan-key.pem`: รัน **HTTPS** ที่ `https://<IP เครื่อง>:8443` และพอร์ต 8080 redirect ไป HTTPS · cookie เป็น `Secure` อัตโนมัติ
- log เป็น JSON ทั้งใน terminal และ `logs/server.log`
- API และ WebSocket ทั้งหมด: [docs/api.md](docs/api.md)

### ทำไมมี `.npmrc` (`ignore-scripts=true`)

better-sqlite3 13 และ bcrypt 6 มี native binary ที่ build ไว้แล้ว **ติดมาในแพ็กเกจที่ดาวน์โหลดจาก npm เลย**
(`node_modules/better-sqlite3/prebuilds/win32-x64.node`, `node_modules/bcrypt/prebuilds/win32-x64/bcrypt.node`)
และตัว library เลือกไฟล์ตาม `process.platform`-`process.arch` ตอน `require` จึงไม่ต้องรัน install script เพื่อ build หรือดาวน์โหลดอะไรเพิ่ม

ปัญหาคือเวลาติดตั้งจาก `package-lock.json` npm จะสั่ง `node-gyp rebuild` ให้ better-sqlite3 (เพราะในแพ็กเกจมี `binding.gyp`)
ซึ่งต้องมี Visual Studio C++ — `.npmrc` จึงปิด install script ของ dependency ทั้งหมด (`npm test`, `npm run ...` ยังทำงานปกติ)
ผลข้างเคียง: ถ้าเพิ่ม dependency ใหม่ที่ต้องรัน install script จริง ๆ มันจะไม่ทำงาน — `npm run doctor` และ test จะเป็นตัวจับ

### แก้ปัญหา `npm install` / `npm run doctor`

| อาการ | วิธีแก้ |
| --- | --- |
| `gyp ERR! find VS ... Could not find any Visual Studio installation` | ไฟล์ `.npmrc` หายหรือถูกแก้ → `git checkout -- .npmrc` แล้ว `Remove-Item -Recurse node_modules; npm install` |
| `Cannot find module ...better_sqlite3.node` | ติดตั้งไม่ครบหรือ platform ไม่มี prebuild (มีเฉพาะ win32/linux/macOS x64/arm64) → `Remove-Item -Recurse node_modules; npm install` |
| `Node ... ต่ำกว่า >=22` | ติดตั้ง Node.js 22 LTS ขึ้นไป แล้ว `npm install` ใหม่ |
| `เขียน SQLite ใน ... ไม่ได้` | ตรวจ `DB_PATH` ใน `.env` และสิทธิ์เขียนโฟลเดอร์ `db/` (OneDrive/antivirus อาจล็อกไฟล์) |
| `มี migration ที่ยังไม่รัน` | `npm run db:init` |
| `ยังไม่มีฐานข้อมูล` | `npm run db:init; npm run db:seed` |
| `inference ยังไม่ได้รันที่ ...` | เปิดอีกหน้าต่าง `npm run inference` หรือใช้ `INFERENCE_MODE=mock` |
| `ยังไม่ได้ติดตั้ง inference/.venv` | `cd inference; uv sync` (ต้องมี uv: `winget install astral-sh.uv`) |

## สถานะปัจจุบัน

- `v0.1.0-prototype` — clickable prototype (vanilla JS, hash router) ใช้ข้อมูลจำลองจาก `web/data.js` ยังไม่มี backend
- Phase 3: server Node.js (Express + ws) — login/สิทธิ์ admin·staff ที่ server, REST session/รถเข็น/โมเดล/alert/analytics, WebSocket admin/display/device (UI ยังใช้ข้อมูลจำลองจนถึง Phase 8)
- Phase 4: inference service (FastAPI + Ultralytics, ByteTrack ต่อรถเข็น) + โหมด mock · สลับโมเดลจาก API โหลด weights จริง
- Phase 5: data pipeline เต็มสาย (คิว → inference → tracker → SQLite → หน้าจอ) + หน้า `device.html` ใช้มือถือเป็นกล้องผ่าน Wi-Fi (HTTPS ใน LAN)
- Phase 6: ติดตามสินค้ารายชิ้น (ถูกบัง ≠ หยิบออก) + เหตุผลการเปลี่ยนสินค้า real-time + `npm run rq4` เทียบโหมด tracker — [docs/presence-reasons.md](docs/presence-reasons.md)
- Phase 7: หน้า "สินค้าและราคา" ต่อ API จริง — ค้นหาชื่อไทย/บาร์โค้ด, สแกนด้วยกล้อง (BarcodeDetector + ZXing ในเครื่อง), แก้สินค้า/ราคา (SCD2) + audit, staff ถูกบล็อกที่ server · login ผ่าน server แล้ว (`?mock=1` = prototype เดิม)
- Phase 8: ทุกหน้าใช้ข้อมูลจริง (REST + WebSocket) · `?mock=1` = prototype เดิม · demo วันสอบด้วย `INFERENCE_MODE=mock` + ปุ่มจำลองบนหน้าลูกค้า — [docs/ui.md](docs/ui.md)
- Phase 9: batch jobs ใน server (session timeout, analytics รายวัน, backup + restore, retention 30 วัน) + export retrain / latency — [docs/jobs.md](docs/jobs.md)
- P2.7 device client: ปุ่ม "เพิ่ม device (กล้องมือถือ)" + QR จริงใน Admin › Live, ภาพสดในการ์ด Live grid (`latest.jpg` จากหน่วยความจำ), `device.html` เริ่มจากปุ่ม เริ่มส่งภาพ / หยุด, ไม่มี server = ข้อมูลจำลองอัตโนมัติ — [docs/phone-camera.md](docs/phone-camera.md)
- P2.8 device 30 fps: ภาพคงสัดส่วนตั้งแต่กล้องถึงโมเดล (ไม่ยืด/ครอป, letterbox, EXIF), มือถือส่งได้ถึง 30 fps (หน้าต่าง 8 เฟรม, Worker encoder), tracker นับหน้าต่างเป็นวินาที, inference ใช้ GPU thread เดียว — [docs/phone-camera.md](docs/phone-camera.md) · [docs/pipeline.md](docs/pipeline.md)
- สิ่งที่ต้องทำด้วยมือ (มือถือจริง, firewall, CA) และงานค้าง: [docs/roadmap.md](docs/roadmap.md)

## Branch

- `main` — เวอร์ชันเสถียร ใช้ demo ได้ ติด tag ทุกครั้งที่ merge
- `develop` — รวมงานที่เสร็จแล้ว
- `feature/*`, `chore/*`, `fix/*` — แตกจาก `develop` ทีละงาน
