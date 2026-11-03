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
```

- หน้า `device.html` ขออนุญาตใช้กล้องหลัง → แสดงภาพพร้อม ROI สีเหลือง และสถานะ "เชื่อมต่อแล้ว · ส่งภาพ"
- ระบบเริ่มตรวจนับเมื่อลูกค้าสแกน QR ของรถเข็นแล้วมี session ก่อนหน้านั้นจะขึ้นป้าย "ยังไม่มีลูกค้าใช้รถเข็นคันนี้" ไม่บันทึกอะไร
- ตั้งค่า fps (2 / 4 / 5), ด้านยาว (480 / 640 px) และคุณภาพ JPEG (0.5 / 0.7 / 0.9) ได้บนหน้าจอ ค่าจะจำไว้ในเครื่อง ตรงกับ matrix การทดลองของ instruction ส่วนที่ 3
- `device-link` สร้าง token ใหม่ทุกครั้ง ลิงก์เก่าจะต่อใหม่ไม่ได้ (เครื่องที่ต่ออยู่แล้วยังใช้ต่อได้)
- รถเข็นละ 1 กล้อง ถ้าเปิดลิงก์บนเครื่องที่สอง เครื่องแรกจะถูกตัดและแสดงข้อความแจ้ง

### ตั้ง ROI จากมือถือ (admin)

มุมกล้องเปลี่ยนทุกครั้งที่ติดมือถือ ให้ admin ตั้ง ROI ใหม่ดังนี้
1. บนมือถือเครื่องเดียวกัน เข้า `https://<IP>:8443/#/a/login` แล้ว login เป็น admin (หน้า login ต่อ API จริงใน Phase 8; ระหว่างนี้ใช้ `POST /api/auth/login`)
2. เปิดลิงก์กล้องอีกครั้ง จะมีปุ่ม **ตั้ง ROI** → ลากมุมสีเหลืองทั้ง 4 ให้ล้อมพื้นตะกร้า → บันทึก
3. มีผลกับเฟรมถัดไปทันที (`PUT /api/admin/carts/:label/roi`) staff ไม่เห็นปุ่มนี้และ server ตอบ 403

## วัดผล (บทที่ 4)

- มือถือวัด **RTT** (ส่ง → ack) และ **E2E** (ส่ง → ผลตรวจของเฟรมนั้นกลับมา) ด้วยนาฬิกาของตัวเอง แล้วส่งเข้า `frames.rtt_ms` / `e2e_ms` ทุก 2 วินาที
- ดูผลรวม: `npm run export:latency` (Phase 9) หรือ query `v_frame_latency`
- DoD Phase 5: ส่ง 4 fps ได้, E2E p95 < 1 วินาที, เฟรมถูกทิ้ง < 5% — ให้ทดสอบ 5 นาทีด้วยมือถือจริงแล้วดูค่า:

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

ถ้า cert ใช้ไม่ได้จริง ๆ และมีอินเทอร์เน็ต: ติดตั้ง `cloudflared` แล้วรัน

```powershell
cloudflared tunnel --url https://localhost:8443 --no-tls-verify
```

จะได้ URL `https://xxxx.trycloudflare.com` ที่ใช้กล้องได้ทันทีโดยไม่ต้องติดตั้ง CA แต่ภาพจะวิ่งผ่านอินเทอร์เน็ต latency สูงกว่า LAN มาก จึงไม่ควรใช้วัดผลในบทที่ 4 และต้องไม่ใช้กับข้อมูลลูกค้าจริง
