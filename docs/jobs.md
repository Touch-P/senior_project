# Batch jobs (Phase 9)

สาย batch ตาม brief หัวข้อ 5 ทุก job รันซ้ำได้ (idempotent) และบันทึกผลลง `job_runs` (`job`, `started_at`, `finished_at`, `status`, `rows_affected`, `message`)

| Job | ทำอะไร | ตารางเวลา (เวลาสาขา `stores.timezone`) | รันเอง |
| --- | --- | --- | --- |
| product master | `products_master.csv` → `products` + `product_prices` (SCD2) ไม่ทับสินค้า/ราคาที่ admin แก้แล้ว | ทุกครั้งที่ server start | `npm run db:seed` |
| session close | ปิด session: `total_auto`, `item_count`, ปิด presence ทุกชิ้น (`CHECKOUT`), finalize เหตุผลที่ค้าง | ตอน checkout และตอน timeout | — |
| session timeout | session ที่ไม่มีเฟรม/เหตุการณ์เกิน `SESSION_IDLE_MS` (30 นาที) → `timeout` (มีของ) / `abandoned` (ว่าง) | ทุกนาที | `npm run job -- timeout` |
| analytics | `daily_product_stats`, `daily_cooccurrence` (support, confidence, **lift คำนวณใน Node.js**), `daily_change_reasons` ของเมื่อวาน + วันนี้ | 02:00 ทุกวัน + หลัง checkout ทุกครั้ง | `npm run job -- analytics [--day 2026-11-02]` |
| backup | `db.backup()` ขณะ server ทำงาน → `db/backups/smartcart-YYYYMMDD-HHMMSS.db` (ไฟล์เดี่ยว ไม่มี -wal) ตรวจ `integrity_check` เก็บ 7 ชุดล่าสุด | 02:30 ทุกวัน | `npm run db:backup` |
| retention | ลบ `frames` + `detections` (cascade) และไฟล์ภาพที่เก่ากว่า `RETENTION_DAYS` (30) แล้ว `VACUUM` · เฟรมของรายงานลูกค้าที่ยังไม่ export ถูกเก็บไว้ | อาทิตย์ 03:00 | `npm run job -- retention [--days 30]` |
| export retrain | รายงาน "รายการไม่ถูกต้อง" → `exports/retrain/{date}/images/`, `labels/` (YOLO txt จาก detection เดิม = pre-annotation), `manifest.csv`, `data.yaml` สำหรับ Roboflow · รายงานที่ export แล้วเป็น `exported` | เมื่อต้องการ | `npm run export:feedback [-- --all]` |
| export latency | `v_frame_latency` + `rtt_ms` / `e2e_ms` + ขนาดภาพ, โมเดล, `camera_desc` → CSV สำหรับบทที่ 4 | เมื่อต้องการ | `npm run export:latency [-- --hours 24 \| --session <id>]` |

ปิด scheduler ได้ด้วย `JOBS=off` (เช่นตอนรันหลาย instance ทดลอง)

## Backup / restore

```powershell
npm run db:backup                    # สำรองทันที (server รันอยู่ได้)
npm run db:restore                   # รายการ backup
# หยุด server ก่อน แล้ว:
npm run db:restore -- db/backups/smartcart-20261103-023000.db --yes
```

- ก่อนแทนที่ ฐานข้อมูลปัจจุบันจะถูก checkpoint แล้วคัดลอกไป `db/backups/pre-restore-<เวลา>.db` เสมอ จึงย้อนกลับการ restore ได้ (job backup ไม่ลบไฟล์ `pre-restore-*`)
- ตรวจ `integrity_check` ทั้งไฟล์ backup ก่อน restore และไฟล์หลัง restore

**ทดสอบแล้ว:**
- `server/test/jobs.test.js`: backup 3 ชุดแล้วเก็บ 2 ชุดล่าสุด → ทำข้อมูลเสีย → restore → ข้อมูลกลับมาครบ และไฟล์ที่เสียถูกเก็บไว้เป็น pre-restore
- ผ่าน CLI กับไฟล์จริง: `npm run db:backup` → `npm run db:restore -- … --yes` → integrity ok

## ตัวเลือกใน `.env`

```text
JOBS=on
SESSION_IDLE_MS=1800000
RETENTION_DAYS=30
BACKUP_DIR=db/backups
BACKUP_KEEP=7
EXPORT_DIR=exports
```

`exports/`, `db/backups/` และ `data/frames/` อยู่ใน `.gitignore` (ข้อมูลภาพและฐานข้อมูลไม่ขึ้น git)
