# Smart Cart

รถเข็นอัจฉริยะที่ใช้กล้องมองลงในตะกร้าและโมเดล YOLO ตรวจจับสินค้า เพื่อแสดงรายการและราคารวมให้ลูกค้าแบบ real-time โดยไม่ต้องสแกนบาร์โค้ด พร้อม dashboard ให้ผู้ดูแลดูรถเข็นสดและวิเคราะห์พฤติกรรมการหยิบสินค้าเข้า–ออก

Senior project ภาค 2 · โมเดลที่ใช้ใน prototype: `yolo11s-s0-20261025` (mAP50-95 0.916)

## เปิด prototype

ต้องมี Node.js 20 ขึ้นไป

```powershell
npx serve web
```

แล้วเปิด URL ที่ terminal แสดง (ปกติคือ `http://localhost:3000`)

- หน้าลูกค้า: `#/` (แสดงผลดีที่สุดบนจอกว้าง จะมีแผงจำลอง real-time ด้านขวา)
- หน้า admin: `#/a/login` · บัญชีทดลอง `admin@smartcart.co.th` / `admin1234` และ `staff@smartcart.co.th` / `staff1234` (เป็นรหัสปลอมของ prototype เท่านั้น)

## ติดตั้ง backend และฐานข้อมูล

ต้องมี Node.js 22 ขึ้นไป (ไม่ต้องมี Visual Studio เพราะ native module ใช้ไฟล์ prebuilt ที่มากับแพ็กเกจ)

```powershell
Copy-Item .env.example .env   # แล้วแก้ ADMIN_PASSWORD และ SESSION_SECRET
npm install
npm run db:init               # สร้าง db/smartcart.db จาก db/migrations
npm run db:seed               # สินค้า 20 รายการ, รถเข็น, โมเดล, บัญชี admin
npm test
```

รายละเอียด schema: [docs/database.md](docs/database.md)

## สถานะปัจจุบัน

- `v0.1.0-prototype` — clickable prototype (vanilla JS, hash router) ใช้ข้อมูลจำลองจาก `web/data.js` ยังไม่มี backend
- กำลังทำ: backend Node.js + SQLite, inference service (Python/Ultralytics), data pipeline และใช้มือถือเป็นกล้องผ่าน Wi-Fi

## Branch

- `main` — เวอร์ชันเสถียร ใช้ demo ได้ ติด tag ทุกครั้งที่ merge
- `develop` — รวมงานที่เสร็จแล้ว
- `feature/*`, `chore/*`, `fix/*` — แตกจาก `develop` ทีละงาน
