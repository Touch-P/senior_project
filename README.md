# Smart Cart

รถเข็นอัจฉริยะที่ใช้กล้องมองลงในตะกร้าและโมเดล YOLO ตรวจจับสินค้า เพื่อแสดงรายการและราคารวมให้ลูกค้าแบบ real-time โดยไม่ต้องสแกนบาร์โค้ด พร้อม dashboard ให้ผู้ดูแลดูรถเข็นสดและวิเคราะห์พฤติกรรมการหยิบสินค้าเข้า–ออก

Senior project ภาค 2 · โมเดลที่ใช้ใน prototype: `yolo11s-s0-20261025` (mAP50-95 0.916)

## ความต้องการของเครื่อง

- **Node.js 22 ขึ้นไป** (กำหนดใน `package.json` → `engines.node: ">=22"` เพราะ better-sqlite3 13 รองรับตั้งแต่ Node 22) — ทดสอบแล้วบน Node 24
- ไม่ต้องติดตั้ง Visual Studio / build tools
- ตรวจเครื่องได้ด้วย `npm run doctor`

## เปิด prototype

```powershell
npx serve web
```

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

## สถานะปัจจุบัน

- `v0.1.0-prototype` — clickable prototype (vanilla JS, hash router) ใช้ข้อมูลจำลองจาก `web/data.js` ยังไม่มี backend
- กำลังทำ: backend Node.js + SQLite, inference service (Python/Ultralytics), data pipeline และใช้มือถือเป็นกล้องผ่าน Wi-Fi

## Branch

- `main` — เวอร์ชันเสถียร ใช้ demo ได้ ติด tag ทุกครั้งที่ merge
- `develop` — รวมงานที่เสร็จแล้ว
- `feature/*`, `chore/*`, `fix/*` — แตกจาก `develop` ทีละงาน
