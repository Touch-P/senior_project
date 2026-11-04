# ใช้มือถือเป็นกล้องรถเข็น (Wi-Fi วงเดียวกัน)

Browser เปิดกล้องได้เฉพาะหน้า `https://` (หรือ `localhost`) ถ้ามือถือเข้า `http://192.168.x.x` จะเปิดกล้องไม่ได้ จึงต้องทำ cert สำหรับ IP ของเครื่องก่อน

## ทำครั้งแรกครั้งเดียว

| # | ทำที่ | คำสั่ง / ขั้นตอน | ต้องใช้ Admin |
| --- | --- | --- | --- |
| 1 | PC | ตั้ง Wi-Fi เป็น **Private**: Settings → Network & internet → Wi-Fi → (ชื่อ Wi-Fi) → Network profile type → Private | ไม่ |
| 2 | PC | `npm run lan-https` สร้าง `certs/lan.pem`, `certs/lan-key.pem`, `certs/smartcart-ca.crt` และแสดง QR | ไม่ |
| 3 | PC | เปิด firewall (ดูด้านล่าง) | **ใช่ — รันเอง** |
| 4 | PC | `npm run dev` (หรือ restart ถ้ารันอยู่) จะเห็น `https://<IP>:8443` ใน log | ไม่ |
| 5 | มือถือ | สแกน QR จากข้อ 2 (`http://<IP>:8080/smartcart-ca.crt`) แล้วติดตั้ง CA (ดูตามระบบด้านล่าง) | — |

**เปิด firewall (ข้อ 3):** คลิกขวา PowerShell → Run as administrator แล้วรัน

```powershell
cd C:\Users\Acer\Desktop\SNP\senior_project
powershell -ExecutionPolicy Bypass -File scripts\firewall.ps1 -SetPrivate
```

- เปิด inbound TCP 8443 และ 8080 เฉพาะเครือข่ายแบบ Private
- `-SetPrivate` เปลี่ยน Wi-Fi ปัจจุบันเป็น Private ให้ด้วย (แทนข้อ 1)
- ลบ rule ทีหลังได้ด้วย `scripts\firewall.ps1 -Remove`

### ติดตั้ง CA บนมือถือ

CA นี้สร้างบนเครื่องคุณเอง (`certs/ca/`, ไม่อยู่ใน git) ใช้รับรอง cert ของ server ในวง LAN เท่านั้น

**Android**
1. เปิด `http://<IP>:8080/smartcart-ca.crt` ใน Chrome (สแกน QR) → ไฟล์ถูกดาวน์โหลด
2. Settings → Security & privacy → More security settings → Encryption & credentials → Install a certificate → **CA certificate** → Install anyway → เลือก `smartcart-ca.crt`
   (ชื่อเมนูต่างกันตามยี่ห้อ ให้ค้นใน Settings ว่า "CA certificate")
3. ปิดแล้วเปิด Chrome ใหม่

**iPhone / iPad**
1. เปิดลิงก์เดียวกันใน **Safari** → Allow → "Profile Downloaded"
2. Settings → General → VPN & Device Management → Smart Cart LAN CA → Install
3. Settings → General → About → Certificate Trust Settings → เปิด **Full Trust** ของ Smart Cart LAN CA

**PC (ไม่บังคับ):** ถ้าอยากให้ Chrome บนเครื่องนี้เข้า `https://<IP>:8443` โดยไม่เตือน ให้ดับเบิลคลิก `certs\smartcart-ca.crt` → Install Certificate → Current User → Trusted Root Certification Authorities (Windows จะถามยืนยัน — ทำเอง) ถ้าไม่ทำก็ใช้ `https://localhost:8443` บน PC ได้ แต่จะมีคำเตือนหน้าแรก

## ทุกครั้งที่ใช้

```powershell
npm run inference          # หน้าต่างที่ 1 (หรือใช้ INFERENCE_MODE=mock)
npm run dev                # หน้าต่างที่ 2
npm run device-link -- A-07   # QR ของกล้องรถเข็น A-07 → สแกนด้วยมือถือที่จะติดบนรถเข็น
npm run device-link -- A-07 --fps 30   # ให้มือถือเริ่มที่ 30 fps (1-30)
```

หรือไม่ต้องใช้ terminal: login admin → **Live รถเข็น** → ปุ่ม **เพิ่ม device (กล้องมือถือ)** → เลือกรถเข็นและ fps → **สร้าง QR** แล้วสแกนด้วยมือถือ (ช่อง "ที่อยู่ server ที่มือถือเข้าถึงได้" ต้องเป็น `https://<IP>:8443` หรือ URL ของ tunnel ไม่ใช่ localhost)

- หน้า `device.html?cart=A-07&fps=4&token=…` แสดงฟอร์มรถเข็น/fps ก่อน → กด **เริ่มส่งภาพ** จึงขออนุญาตใช้กล้องหลัง (iOS Safari เปิดกล้องได้จากการกดปุ่มเท่านั้น) → แสดงภาพพร้อม ROI สีเหลือง และสถานะ "เชื่อมต่อแล้ว · ส่งภาพ" · **หยุด** = ปิดกล้องและตัดการเชื่อมต่อ
- หน้าจอแสดง **ส่งจริง fps / เป้า**, **กล้อง fps** (เฟรมใหม่จากกล้องต่อวินาที), **RTT** (ส่ง → ack ที่อ้าง `frame_seq` เดียวกัน), **E2E** (ส่ง → ผลตรวจ), จำนวนส่ง / ไม่ได้ผล และ **JPEG q** ที่ใช้อยู่ (มี ↓ เมื่อถูกลดอัตโนมัติ) วัดด้วย `performance.now()` ของมือถือเท่านั้น · E2E มีค่าเมื่อมี session ลูกค้า หรือ admin เปิดหน้า Live detail ของรถเข็นนั้น (ไม่งั้นเฟรมไม่ถูก inference)
- ส่งแบบหน้าต่าง: มีเฟรมที่ยังไม่ได้ ack ค้างได้ไม่เกิน 8 เฟรม (เดิมรอ ack ทีละเฟรม) ack ที่หายเกิน 2 วินาทีจะคืนช่องให้ · เน็ตช้า: ถ้า `ws.bufferedAmount` > 512 KB จะข้ามเฟรมนั้น และถ้าข้ามเกิน 10% ของช่องใน 2 วินาที จะลดคุณภาพ JPEG ทีละ 0.1 (ต่ำสุด 0.4) แล้วค่อยคืนทีละ 0.05 เมื่อเน็ตปกติ 6 วินาที — **ไม่ลดขนาดภาพ** · หลุดแล้วต่อใหม่เองแบบ backoff 0.5 → 1 → 2 → 4 → 8 → 10 วินาที · heartbeat ทุก 10 วินาที · ขอ Screen Wake Lock กันจอดับ
- หน้า Admin › Live แสดงภาพสดในการ์ดของรถเข็น (โหลด `latest.jpg` เมื่อมีเฟรมใหม่) ปิดแท็บมือถือแล้วการ์ดเปลี่ยนเป็น "ขาดการเชื่อมต่อ" ภายใน ~5 วินาที
- ระบบเริ่มตรวจนับเมื่อลูกค้าสแกน QR ของรถเข็นแล้วมี session ก่อนหน้านั้นจะขึ้นป้าย "ยังไม่มีลูกค้าใช้รถเข็นคันนี้" ไม่บันทึกอะไร
- ตั้งค่า fps (2 / 3 / 4 / 5 / 10 / 15 / 20 / 30, ค่าเริ่ม 4), ด้านยาว (480 / 640 px) และคุณภาพ JPEG (0.5 / 0.7 / 0.9) ได้บนหน้าจอ ค่าจะจำไว้ในเครื่อง (2-5 fps ตรงกับ matrix การทดลองของ instruction ส่วนที่ 3) · `?fps=` ในลิงก์รับเลขเต็ม 1-30 · server ตรวจ `settings` ใน `hello` (fps 1-30, size 160-1920, quality 0.1-1) ถ้าผิดตอบ `BAD_SETTINGS`
- `device-link` สร้าง token ใหม่ทุกครั้ง ลิงก์เก่าจะต่อใหม่ไม่ได้ (เครื่องที่ต่ออยู่แล้วยังใช้ต่อได้)
- รถเข็นละ 1 กล้อง ถ้าเปิดลิงก์บนเครื่องที่สอง เครื่องแรกจะถูกตัดและแสดงข้อความแจ้ง

### อัตราส่วนภาพ: ไม่ยืด ไม่ครอป ตั้งแต่กล้องถึงโมเดล

YOLO ใช้ภาพแบบ letterbox (คงสัดส่วน เติมขอบ) และกล่อง/ROI เป็นพิกัด 0-1 เทียบภาพที่มือถือส่ง ถ้าภาพถูกยืดหรือครอปที่ไหนสักจุด กล่องจะเลื่อนจากของจริง

| จุด | ทำอย่างไร |
| --- | --- |
| ขอกล้อง | ขอแค่ `ideal` width 1280 / height 960 / frameRate 30 — ไม่มี `aspectRatio` หรือ `exact` ที่ทำให้ browser ครอป ใช้ขนาดที่กล้องให้มาจริง (`video.videoWidth/Height`) |
| ย่อภาพ | ด้านยาว = ค่า "ด้านยาวของภาพ" (640) ด้านสั้นคำนวณจากสัดส่วนจริง (`web/js/frame-geometry.js`): 1280×960 → 640×480, 960×1280 → 480×640, 1280×720 → 640×360 ไม่มี canvas ขนาดตายตัว |
| หมุนจอ | event `resize` ของ video → คำนวณใหม่ทุกเฟรม และกรอบ preview เปลี่ยน aspect-ratio ตาม (3:4 ↔ 4:3) |
| preview / Admin | `object-fit: contain` ทั้งหน้ามือถือ, การ์ด Live grid และ Live detail (ไม่มี fill / cover) · กรอบ Live detail ใช้ aspect-ratio ของภาพจริง กล่องและ ROI จึงทับตำแหน่งเดิม |
| server | อ่านขนาดจริงจาก JPEG (SOF) ไม่เชื่อ header → `frames.width/height`, header ของภาพที่ส่งให้ admin, `latest.jpg` (`X-Frame-Width/Height`) |
| inference | `decode_image` ใช้ EXIF orientation ก่อน · Ultralytics letterbox (สเกลเดียวทั้งสองแกน + pad) ไม่ resize ตรงเป็น 640×640 ไม่ครอป · กล่อง `xyxyn` เทียบภาพต้นฉบับ (ไม่ใช่ภาพที่ pad) |

ทดสอบ: `server/test/frame-ratio.test.js` (ขนาด 3:4 / 4:3 / 1:1 / 16:9, ขนาดจาก JPEG, กล่องผ่าน server ไม่เปลี่ยน) และ `inference/tests/test_aspect.py` (EXIF, letterbox, กล่องของภาพ 4:3 / 3:4 / 1:1 / หมุน 90° เทียบภาพต้นฉบับ ด้วย weights จริง)

### 30 fps

- จังหวะ: `requestVideoFrameCallback` (เฟรมใหม่จากกล้อง) + นาฬิกาที่ไม่สะสมการเลื่อน (`due += 1000/fps`, ล้าหลังเกิน 1 ช่องเริ่มใหม่ ไม่ส่งรวด) · ถ้า rVFC เงียบเกิน 250 ms (พบใน headless Chrome; Safari บางรุ่นก็เป็น) timer รับช่วงทันที และไม่เร็วกว่า frameRate ที่กล้องรายงาน
- encode JPEG ใน Worker + OffscreenCanvas (`web/js/device-encoder.js`) ไม่บล็อกหน้าจอ · browser ที่ไม่มีใช้ canvas ปกติ · encode พร้อมกันได้ไม่เกิน 2 เฟรม ถ้าช้ากว่านั้นข้ามเฟรม
- ส่งเฉพาะเฟรมที่กล้องถอดรหัสแล้วจริง (`readyState ≥ 2`) ไม่ส่งตอนกด "หยุด" / ซ่อนแท็บ / กำลังตั้ง ROI
- throughput ผ่าน tunnel: แบบรอ ack ทีละเฟรมได้ไม่เกิน 1/RTT · หน้าต่าง 8 เฟรมได้ไม่เกิน 8/RTT — วัดด้วย `npm run loadtest -- --delay-ms 100` (RTT ~217 ms): รอทีละเฟรม 4.3 fps, หน้าต่าง 6 = 25.8 fps, หน้าต่าง 8 = **30.1 fps** · RTT ~310 ms ได้ 24.1 fps
- tracker นับหน้าต่างเป็นวินาที (ดู docs/pipeline.md) ADD / REMOVE ที่ 30 fps จึงใช้เวลาเท่าที่ 4 fps

### ตั้ง ROI จากมือถือ (admin)

มุมกล้องเปลี่ยนทุกครั้งที่ติดมือถือ ให้ admin ตั้ง ROI ใหม่ดังนี้
1. บนมือถือเครื่องเดียวกัน เข้า `https://<IP>:8443/#/a/login` แล้ว login เป็น admin (หน้า login ต่อ API จริงใน Phase 8; ระหว่างนี้ใช้ `POST /api/auth/login`)
2. เปิดลิงก์กล้องอีกครั้ง จะมีปุ่ม **ตั้ง ROI** → ลากมุมสีเหลืองทั้ง 4 ให้ล้อมพื้นตะกร้า → บันทึก
3. มีผลกับเฟรมถัดไปทันที (`PUT /api/admin/carts/:label/roi`) staff ไม่เห็นปุ่มนี้และ server ตอบ 403

## วัดผล (บทที่ 4)

- มือถือวัด **RTT** (ส่ง → ack) และ **E2E** (ส่ง → ผลตรวจของเฟรมนั้นกลับมา) ด้วยนาฬิกาของตัวเอง แล้วส่งเข้า `frames.rtt_ms` / `e2e_ms` ทุก 2 วินาที
- ดูผลรวม: `npm run export:latency` (Phase 9) หรือ query `v_frame_latency`
- DoD Phase 5: ส่ง 4 fps ได้, E2E p95 < 1 วินาที, เฟรมถูกทิ้ง < 5% (P2.8: ทดสอบที่ 30 fps ด้วย) — ให้ทดสอบ 5 นาทีด้วยมือถือจริงแล้วดูค่า:

**ยังไม่ได้ทดสอบกับมือถือจริงในรอบ P2.8** (30 fps, หมุนจอ, Worker encoder บน Android/iOS, cloudflared จริง) — ทดสอบแล้วเฉพาะ headless Chrome + กล้องจำลอง (1280×960 และ 960×1280 ที่ 20 fps ซึ่งเป็นเพดานของกล้องจำลอง: ส่งได้ 20 fps, ไม่มีเฟรมถูกทิ้ง, ภาพ 640×480 / 480×640, E2E p95 ~30 ms) และ load test

```sql
SELECT COUNT(*) AS frames, ROUND(100.0 * SUM(dropped) / COUNT(*), 1) AS dropped_pct,
       ROUND(COUNT(*) / ((MAX(t_received_ms) - MIN(t_received_ms)) / 1000.0), 2) AS fps
FROM frames WHERE session_id = '<session>';
```

## แก้ปัญหา

| อาการ | สาเหตุ / วิธีแก้ |
| --- | --- |
| มือถือเปิด `https://<IP>:8443` ไม่ได้เลย (timeout) | Wi-Fi ของ PC ยังเป็น Public หรือยังไม่ได้รัน `firewall.ps1` · มือถือกับ PC อยู่คนละวง (ดู IP ต้องขึ้นต้นเหมือนกัน เช่น 192.168.10.x) · router เปิด AP/client isolation (Wi-Fi ร้านกาแฟ/ห้องสมุดมักเปิด) → ใช้ hotspot มือถืออีกเครื่องแทน |
| "Your connection is not private" | ยังไม่ได้ติดตั้ง CA บนมือถือ หรือ iOS ยังไม่เปิด Full Trust |
| "ต้องเปิดผ่าน HTTPS" ในหน้ากล้อง | เปิดด้วย `http://` — ใช้ลิงก์จาก `npm run device-link` |
| "เปิดกล้องไม่ได้" | อนุญาตกล้องให้ site นี้ใน browser แล้วรีเฟรช |
| "เชื่อมต่อไม่ได้" หลังลองหลายครั้ง | token เก่า (มีคนรัน device-link ใหม่) หรือ server ไม่ได้รัน |
| IP ของ PC เปลี่ยน (DHCP) | รัน `npm run lan-https` ใหม่ แล้ว restart server (CA เดิมยังใช้ได้ ไม่ต้องติดตั้งบนมือถือซ้ำ) |

### แผนสำรอง: cloudflared tunnel

ถ้า cert ใช้ไม่ได้จริง ๆ และมีอินเทอร์เน็ต: ติดตั้ง `cloudflared` (`winget install Cloudflare.cloudflared`) แล้วรันคู่กับ `npm run dev`

```powershell
# มี certs/lan.pem แล้ว (server เป็น HTTPS)
cloudflared tunnel --url https://localhost:8443 --no-tls-verify
# ยังไม่มี cert (server เป็น HTTP บน 127.0.0.1:8443)
cloudflared tunnel --url http://localhost:8443
```

จะได้ URL `https://xxxx.trycloudflare.com` ที่ใช้กล้องได้ทันทีโดยไม่ต้องติดตั้ง CA
- เปิดหน้า Admin ผ่าน URL ของ tunnel แล้วกด "เพิ่ม device (กล้องมือถือ)" QR จะชี้ไปที่ tunnel เอง หรือใส่ `PUBLIC_URL=https://xxxx.trycloudflare.com` ใน `.env` ให้ `npm run device-link` และปุ่มใน Admin ใช้ URL นี้ (URL ของ quick tunnel เปลี่ยนทุกครั้งที่รันใหม่)
- server เชื่อ `X-Forwarded-Proto/For` เฉพาะจาก proxy บนเครื่องเดียวกัน (`trust proxy = loopback`) cookie จึงเป็น `Secure` และ rate limit ของ login นับตาม IP จริง
- ยังไม่ได้ทดสอบกับ tunnel จริงในรอบนี้ ถ้า `/ws/...` ตอบ 403 แปลว่า tunnel เปลี่ยน Host header ไม่ตรงกับ Origin แต่ภาพจะวิ่งผ่านอินเทอร์เน็ต latency สูงกว่า LAN มาก จึงไม่ควรใช้วัดผลในบทที่ 4 และต้องไม่ใช้กับข้อมูลลูกค้าจริง
