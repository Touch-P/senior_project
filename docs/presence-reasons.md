# ติดตามสินค้ารายชิ้น + เหตุผลการเปลี่ยนสินค้า (Phase 6)

กติกาหลัก: **สินค้าหายไปจากภาพ ≠ สินค้าถูกหยิบออก** เหตุผลการเปลี่ยนสินค้าเกิดได้จาก REMOVE ที่มีหลักฐานการหยิบออกเท่านั้น

| ไฟล์ | หน้าที่ |
| --- | --- |
| `server/src/pipeline/presence.js` | state machine รายชิ้น (IN_CART / OCCLUDED / REMOVED), หลักฐานการหยิบออก, model flip, CORRECTION — pure function รับเวลาเป็น input |
| `server/src/pipeline/reasons.js` | reason engine (rule_version `v1`) — pure function |
| `server/src/pipeline/presenceModel.js` | บันทึก `cart_item_presence` (SCD2), `cart_events`, `change_reasons`, alert และส่ง `/ws/admin` |
| `server/src/pipeline/replay.js` | เล่น scenario ผ่าน tracker + presence + SQLite ในเวลาจำลอง (ใช้ใน test และ RQ4) |
| `scripts/make-reason-scenarios.js` | สร้าง scenario 12 สถานการณ์ของ brief 7.7 (`server/test/scenarios/r01…r12`) |
| `scripts/rq4-tracker-modes.js` | ทดลอง RQ4: เทียบโหมด tracker |

## ⚠ สิ่งที่ผมตัดสินใจเองระหว่างที่คุณไม่อยู่ (จุดหยุดข้อ 3 และ 6) — ขอให้ตรวจ

1. **ตาราง attribute 20 คลาส** ใช้ตาม `db/seed/products_master.csv` ด้านล่าง ซึ่งรวมการตัดสินใจเดิมของคุณแล้ว (เทียบแบรนด์ด้วย `sub_category`, Babi Mild / Kirei แยก `sub_category` เพราะคำตอบในข้อความของคุณยังเป็น placeholder)
2. **ค่า threshold ของ presence** (ส่งผลต่องานวิจัย) ตั้งตาม brief ทุกค่าที่ brief ระบุ และเพิ่ม 4 ค่าที่ brief ไม่ได้ระบุ (★)

| ค่า | ใช้ | ที่มา |
| --- | --- | --- |
| W = 8, K = 3, REMOVE หลังหาย 2W = 16 เฟรม (จำนวนเฟรมที่ 4 fps; รถเข็นที่เร็วกว่า 6 fps คูณด้วย fps/4 ให้เป็นวินาทีเท่าเดิม เช่น 30 fps: W=60, K=23, 2W=120 — docs/pipeline.md) | tracker / exit evidence | brief 5, 7.2 |
| ขอบ ROI = 12% ของขนาด ROI | exit evidence ข้อ 1 | brief 7.2 |
| coverage ≥ 0.3 = ถูกบัง | exit evidence ข้อ 3 | brief 7.2 |
| หายเกิน 3 เฟรม → OCCLUDED | 7.1 | brief 7.1 |
| flip: IoU ≥ 0.5 ภายใน 2 วินาที, แก้คลาสเมื่อนิ่ง 2W เฟรมและ conf เฉลี่ยสูงกว่า | 7.3 | brief 7.3 |
| CORRECTION ภายใน 10 วินาทีหลัง REMOVE | 7.1 | brief 7.1 |
| จับคู่ ±60 วินาที, เพิ่มจำนวนเมื่อห่าง ADD ก่อนหน้า > 30 วินาที | 7.5 | brief 7.5 |
| ★ "เคลื่อนออกทางขอบ" = ระยะถึง **ขอบเส้นที่ใกล้ตำแหน่งสุดท้าย** ใน 3–4 เฟรมสุดท้ายลดลง รวม ≥ 0.02 ยอม noise ต่อเฟรม 0.01 | exit evidence ข้อ 2 | ไม่ได้ระบุ — ถ้าวัดกับ "ขอบที่ใกล้ที่สุด" ของที่วางชิดขอบเอียงของ ROI จะตีความผิด |
| ★ เห็นกล่องคลาสเดียวกันนอก ROI ที่ตำแหน่งเดิมตอนหาย = หลักฐานการเคลื่อนออก (แทนข้อ 2 ได้) | exit evidence | ไม่ได้ระบุ |
| ★ ADD ต้องมีกล่องของคลาสนั้นที่ไม่มีชิ้นไหนจับคู่ในเฟรมนั้นจริง | 7.1 แถวแรก | ไม่ได้ระบุ — กัน ADD หลอกจากจำนวนที่ค้างใน window |
| ★ คู่ที่เข้ากติกาอันดับ 2–4 เป็นคู่ชั่วคราว รอจนหมดช่วงเวลา ถ้ามีคู่อันดับดีกว่าเข้ามาจะแทนที่ (BRAND_SWITCH final ทันที) | 7.5 | ทำให้ test 10 ได้ BRAND_SWITCH ไม่ว่าของไหนเข้าก่อน |

3. **โหมด tracker กับ presence:** presence ใช้ร่วมกับทุกโหมด และเพิ่ม `PRESENCE_RULES=false` ไว้ทำ baseline (a) แบบนับรายเฟรมตรง ๆ ทุกการเปลี่ยนจำนวนเป็น ADD/REMOVE ทันที

## ตาราง attribute (brief 7.4) — `db/seed/products_master.csv`

| class_name | brand | product_line | flavor | variant | sub_category | ราคา |
| --- | --- | --- | --- | --- | --- | --- |
| babimild_double_milk | Babi Mild | Babi Mild | double_milk | standard | baby_care | 35 |
| babimild_sweety_pink | Babi Mild | Babi Mild | sweety_pink | standard | baby_care | 35 |
| babimild_white_sakura | Babi Mild | Babi Mild | white_sakura | standard | baby_care | 40 |
| bengbeng_pack12 | Bengbeng | Beng Beng wafer | chocolate | pack12 | sweet_snack | 48 |
| doritos_mid_nacho | Doritos | Doritos | nacho_cheese | mid | chips | 20 |
| kirei_refill_floral | Kirei Kirei | Kirei Kirei refill | floral | refill | hand_soap | 29 |
| kirei_refill_lavender | Kirei Kirei | Kirei Kirei refill | lavender | refill | hand_soap | 29 |
| kirei_refill_ori | Kirei Kirei | Kirei Kirei refill | original | refill | hand_soap | 29 |
| kirei_refill_peach | Kirei Kirei | Kirei Kirei refill | peach | refill | hand_soap | 29 |
| koalas_march_chocolate | Lotte | Koala's March | chocolate | standard | sweet_snack | 23 |
| kohkae_small_wasabi | Kohkae | Koh-Kae coated peanut | wasabi | small | nuts | 11 |
| lay_big_nori | Lay's | Lay's | nori | big | chips | 31 |
| lay_big_ori | Lay's | Lay's | original | big | chips | 31 |
| lay_big_rock_ori | Lay's | Lay's | original | big_rock | chips | 31 |
| lay_party_ori | Lay's | Lay's | original | party | chips | 45 |
| mama_cup_ok_cheeseGo | Mama | Mama Cup OK | cheese_gochujang | cup | instant_noodle | 20 |
| mama_cup_ok_hotKR | Mama | Mama Cup OK | hot_korean | cup | instant_noodle | 20 |
| pringles_norm_ori | Pringles | Pringles | original | normal | chips | 45 |
| pringles_norm_sourcream | Pringles | Pringles | sour_cream | normal | chips | 45 |
| rosdee_mid_pork | Rosdee | Rosdee seasoning | pork | mid | seasoning | 13 |

ตัวอย่างผลของกติกา: Lay's → Pringles / Doritos = เปลี่ยนแบรนด์ (chips เหมือนกัน), Bengbeng → Koala's March = เปลี่ยนแบรนด์ (sweet_snack), Lay's original → nori = เปลี่ยนรส, big → party / big_rock = เปลี่ยนขนาด/แพ็ก, Lay's → Koala's March = ABANDON + ADD ธรรมดา (คนละ sub_category) ถ้าแก้ CSV แล้วรัน `npm run db:seed` กติกาจะใช้ค่าใหม่ทันที

## State ของแต่ละชิ้น (`cart_item_presence`, SCD2)

| จาก → ไป | เมื่อไร | `change_cause` | ราคา |
| --- | --- | --- | --- |
| — → IN_CART | จำนวนนิ่งของคลาสมากกว่าชิ้น IN_CART + OCCLUDED และเห็นกล่องใหม่จริง | ADDED | บวก |
| IN_CART → OCCLUDED | ไม่เห็นเกิน 3 เฟรม ไม่มีหลักฐานการออก (บันทึก `occluded_by_product_id` เมื่อมีกล่องอื่นทับ ≥ 30%) | NOT_SEEN | ไม่เปลี่ยน |
| OCCLUDED → IN_CART | เห็นคลาสเดิมใน ROI อีกครั้ง ไม่นับ ADD | SEEN_AGAIN | ไม่เปลี่ยน |
| IN_CART → REMOVED | exit evidence ครบ 4 ข้อของ 7.2 | EXIT_EVIDENCE | ลบ |
| REMOVED → IN_CART | เห็นคลาสเดิมภายใน 10 วินาทีโดยไม่ได้เข้ามาจากขอบ → เหตุผลของ REMOVE นั้นถูก void | CORRECTION | บวกกลับ |
| A → B (model flip) | B นิ่ง 2W เฟรมที่ตำแหน่งเดิมและ conf เฉลี่ยสูงกว่า (ก่อนหน้านั้นมีแค่ alert `MODEL_FLIP`) | CORRECTION | ราคา B |
| ทุกชิ้น → ปิด | checkout (ชิ้นที่ OCCLUDED ยังคิดเงิน + alert `OCCLUDED_AT_CHECKOUT`) | CHECKOUT | — |

## ผล test 12 สถานการณ์ (brief 7.7)

`server/test/reasons.test.js` เล่นแต่ละ scenario (4 fps) ผ่าน tracker + presence + reason engine + SQLite จริงในเวลาจำลอง แล้วตรวจกับ `expect` ในไฟล์ **ผ่านครบ 12/12** และยังเปิดดูบน demo ได้ด้วย `MOCK_SCENARIO=r07-occluded` เป็นต้น

| # | Scenario | ผลที่ได้ |
| --- | --- | --- |
| 1 | r01-brand-switch | BRAND_SWITCH lay_big_ori → pringles, gap ~10 วินาที |
| 2 | r02-flavor-switch | FLAVOR_SWITCH |
| 3 | r03-variant-switch | VARIANT_SWITCH |
| 4 | r04-qty-change | QTY_CHANGE 3 → 2 (final เมื่อหมด 60 วินาที) |
| 5 | r05-abandon-dwell | ABANDON, dwell 40–44 วินาที |
| 6 | r06-abandon-and-add | ABANDON lay_big_nori + koalas เป็น ADD ธรรมดา |
| 7 | r07-occluded | OCCLUDED โดย bengbeng, ไม่มี REMOVE, ราคาเท่าเดิม |
| 8 | r08-occluded-returns | SEEN_AGAIN, ADD ไม่เพิ่ม |
| 9 | r09-model-flip | alert MODEL_FLIP, ไม่มี event/เหตุผล |
| 10 | r10-brand-priority | BRAND_SWITCH กับ pringles (แม้ lay_big_nori เข้าก่อน) |
| 11 | r11-correction | CORRECTION, เหตุผล voided |
| 12 | r12-checkout-occluded | คิดราคา + alert OCCLUDED_AT_CHECKOUT |

นอกจากนี้มี test ว่า admin ได้รับ `change_reason` ผ่าน `/ws/admin` ทันทีหลัง commit (ภายใน 1 วินาที ตาม DoD) และ test ของ model flip correction

## RQ4: เทียบโหมด tracker

```powershell
npm run rq4                                     # scenario ทั้งหมดที่มี expect
npm run rq4 -- --session <session_id>           # session จริงที่บันทึกไว้ (ตาราง detections) → รายการตอนจบของแต่ละโหมด
```

ผลบน scenario สังเคราะห์ 18 ชุด (12 สถานการณ์ + 6 รถเข็นจาก `data.js`):

| configuration | cart accuracy | event ผิด / session |
| --- | --- | --- |
| (a) frame, ไม่มี presence | 83.3 % | 0.39 |
| (b) window + presence (ระบบที่ใช้จริง) | 100 % | 0.00 |
| (b′) window ไม่มี presence | 83.3 % | 0.39 |
| (c) ByteTrack + presence | 100 % | 0.00 |

ข้อควรระวังในการใช้ตัวเลขนี้:
- scenario สังเคราะห์ถูกออกแบบตาม brief จึงพิสูจน์ได้แค่ว่า logic ถูก
- ตัวเลขที่จะใส่ในบทที่ 4 ต้องได้จาก session จริงที่มีผลจริงจากการนับมือ ใช้ `--session` ข้อมูล detections ของทุกเฟรมใน session จะถูกเก็บไว้ จึงเล่นซ้ำกับทุกโหมดได้โดยไม่ต้องถ่ายใหม่
- ในโหมด (c) ของ replay ใช้ id ของวัตถุใน scenario แทน track ID ของ ByteTrack ส่วนตอนรันจริง (`TRACKER_MODE=bytetrack`) จะใช้ ByteTrack ของ inference service

ข้อจำกัดที่รู้:
- ถ้ามีชิ้นคลาสเดียวกันถูกบังอยู่ แล้ววางชิ้นใหม่คลาสเดียวกันลงไป ชิ้นใหม่จะถูกนับเป็นชิ้นที่ถูกบังโผล่กลับมา (SEEN_AGAIN) จนกว่าจำนวนนิ่งจะเกินจำนวนชิ้นที่มีอยู่ ซึ่งเป็นไปตามกติกา 7.1 แถวแรก
- ของที่ถูกยกขึ้นตรง ๆ แล้วหายกลางตะกร้า (ไม่ผ่านขอบ) จะเป็น OCCLUDED เสมอตาม 7.2 พนักงานจะเห็นตอน checkout ผ่าน alert `OCCLUDED_AT_CHECKOUT`
