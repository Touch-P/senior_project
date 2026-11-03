# หน้าเว็บกับข้อมูลจริง (Phase 7–8)

UI ยังเป็น vanilla JS ของ prototype เดิม (`web/app.js` + `styles.css`) และเพิ่มไฟล์ใหม่ทั้งหมดใน `web/js/` โดยใช้ component เดิมทุกชิ้น

| ไฟล์ | หน้าที่ |
| --- | --- |
| `web/js/api.js` | data layer: REST (`API.get/post/…`) + `/ws/admin` (`API.on(type, fn)`, `API.watch(cart)`) · `?mock=1` = ไม่เรียก server เลย |
| `web/js/live.js` | login / logout ผ่าน server, กู้ session ตอนเปิดหน้าใหม่, ตัวเลขบนหน้า login จาก `/api/meta` |
| `web/js/views/customer.js` | C-01…C-09: สแกน QR / กรอกรหัสรถเข็น → `POST /api/sessions`, PDPA + แบบสอบถาม (`PATCH`), ตะกร้าจาก `/ws/display/{id}`, แจ้งรายการผิด, QR สรุปยอดจริง, แผงจำลอง demo |
| `web/js/views/admin.js` | Dashboard, Live grid + detail (ภาพสด, กรอบถูกบัง, เหตุผลสด), โมเดล (สลับจริง), Sessions (timeline + เหตุผล + ภาพหลักฐาน), Latency |
| `web/js/views/products.js` | สินค้าและราคา: ค้นหา, สแกนบาร์โค้ด, แก้สินค้า/ราคา, ผูกบาร์โค้ด, เพิ่มสินค้า |
| `web/js/scanner.js` | กล้อง + BarcodeDetector / ZXing (บาร์โค้ดสินค้า และ QR รถเข็น) |
| `web/js/device.js` | `device.html` มือถือเป็นกล้องรถเข็น |
| `web/vendor/` | ZXing (MIT/Apache-2.0) และ qrcode-generator (MIT) เก็บในเครื่อง ไม่ใช้ CDN |

## สองโหมด

| | ปกติ | `?mock=1` |
| --- | --- | --- |
| ข้อมูล | server (REST + WebSocket) | `web/data.js` เดิม |
| Login | `POST /api/auth/login` ล็อกบัญชีที่ server | `ACCOUNTS` ใน data.js (`admin1234` / `staff1234`) |
| View | ไฟล์ใน `web/js/views/` | ฟังก์ชันเดิมใน `app.js` ทุกหน้า → หน้าตาและพฤติกรรมเหมือน prototype ทุกอย่าง |
| ใช้เมื่อ | ระบบจริง / demo | แผนสำรองวันสอบ (ไม่ต้องมี server เลย: `npx serve web` แล้วเปิด `/?mock=1`) |

`?mock=1` ถูกจำไว้ในแท็บนั้น (sessionStorage) จนกว่าจะเปิด `?mock=0`

## Demo วันสอบ (ไม่ต้องมีมือถือหรือ GPU)

```powershell
$env:INFERENCE_MODE="mock"; npm run dev
```

1. หน้าลูกค้า `http://localhost:8443/#/c/scan` → "กรอกรหัสรถเข็นเอง" → `A-07` (หรือสแกน QR บนรถเข็น / เปิดลิงก์ `/?cart=A-07`)
2. ยอมรับ PDPA → แบบสอบถาม → ตะกร้า
3. แผงด้านขวา **จำลองระบบ (demo)**: "จำลองเปลี่ยนแบรนด์" / "จำลองสินค้าถูกบัง" / "จำลองโมเดลสับสนคลาส" / "จำลองลดจำนวน" / "เล่นรถเข็นตัวอย่าง A-08"
   - server เล่น scenario เข้า pipeline จริง (`POST /api/demo/play`) → ตะกร้าของลูกค้าเปลี่ยน, admin เห็นภาพ + กล่อง + เหตุผลสดที่ `#/a/live/A-07`
4. อีกแท็บ: admin login `admin@smartcart.co.th` / ค่า `ADMIN_PASSWORD` ใน `.env` → Dashboard / Live / Sessions

ปุ่มจำลองมีเฉพาะตอน `INFERENCE_MODE=mock` (`/api/demo` ตอบ 404 ในโหมด real) ถ้าต่อกล้องมือถืออยู่ server จะไม่ให้จำลองทับ

## ตรวจแล้ว (headless Chrome)

- ปกติ: flow ลูกค้าครบ (กรอกรหัส → PDPA → แบบสอบถาม → ตะกร้า → demo เปลี่ยนแบรนด์), admin ทุกหน้า, สินค้า (ค้น/แก้/สแกน), staff ถูกล็อก — **ไม่มี console error**
- `?mock=1`: ทุกหน้าของ prototype — ไม่มี console error, ตัวเลขเหมือนเดิม
- ความกว้าง 390 / 860 / 1200 / 1440 px: **ไม่มี horizontal scroll** ทุกหน้าทั้งสองโหมด (prototype เดิมมีที่ 390/860 — แก้ด้วย CSS section "RESPONSIVE" ท้าย `styles.css`)

## ที่เปลี่ยนจาก prototype (ตั้งใจ)

- ตัวเลขที่เคย hard-code มาจากข้อมูลจริง: chip หน้า login, "สินค้าทั้งหมด (N)", "Active N คัน", ตัวกรอง Live, KPI ของ Dashboard, ประวัติการสลับโมเดล
- Dashboard: ช่วงเวลาเหลือ วันนี้ / 7 วัน / 30 วัน (ไม่มี "กำหนดเอง" เพราะยังไม่มีตัวเลือกวันที่) และเพิ่มการ์ด "เหตุผลการเปลี่ยนสินค้า" + "คู่ที่เปลี่ยนบ่อย" (brief 7.6)
- Live grid: ไม่ส่งภาพทุกคันมาที่หน้า grid (ประหยัดแบนด์วิดท์) — ภาพสดอยู่ใน Live detail (`watch`)
- Live detail: การ์ด "เหตุผลการเปลี่ยนสินค้า (สด)", badge "ถูกบัง", กรอบเส้นประที่ตำแหน่งสุดท้ายของชิ้นที่ถูกบัง, badge เหตุผลบน chip REMOVE
- Sessions: แถวเหตุผลแทรกตามเวลา, ภาพหลักฐานจาก `frames.image_path` (ต้อง login ถึงดูได้)
- เพิ่ม favicon (เคยเป็น 404)
