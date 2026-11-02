// ข้อมูลตัวอย่าง — สินค้า 11 คลาสจากโมเดล, ราคาเป็นค่าตัวอย่าง
const PRODUCTS = {
  bengbeng_pack12:        { name: 'เบงเบง เวเฟอร์ แพ็ก 12 ชิ้น', price: 59, sku: 'SN-BBG-012' },
  doritos_mid_nacho:      { name: 'โดริโทส รสนาโชชีส ขนาดกลาง', price: 30, sku: 'SN-DRT-NCM' },
  koalas_march_chocolate: { name: 'โคอะลา มาร์ช ช็อกโกแลต', price: 22, sku: 'SN-KLM-CHO' },
  kohkae_small_wasabi:    { name: 'โก๋แก่ ถั่ววาซาบิ ซองเล็ก', price: 10, sku: 'SN-KKE-WSS' },
  lay_big_nori:           { name: 'เลย์ รสโนริสาหร่าย ห่อใหญ่', price: 35, sku: 'SN-LAY-NRB' },
  lay_big_ori:            { name: 'เลย์ รสดั้งเดิม ห่อใหญ่', price: 35, sku: 'SN-LAY-ORB' },
  lay_party_ori:          { name: 'เลย์ รสดั้งเดิม ปาร์ตี้แพ็ก', price: 69, promo: 59, sku: 'SN-LAY-ORP' },
  mama_cup_ok_cheeseGo:   { name: 'มาม่า คัพ OK ชีสโก', price: 18, sku: 'ND-MMC-CHG' },
  mama_cup_ok_hotKR:      { name: 'มาม่า คัพ OK ฮอตเกาหลี', price: 18, sku: 'ND-MMC-HKR' },
  pringles_norm_ori:      { name: 'พริงเกิลส์ รสดั้งเดิม', price: 55, sku: 'SN-PRG-ORI' },
  rosdee_mid_pork:        { name: 'รสดี ผงปรุงรสหมู ขนาดกลาง', price: 25, sku: 'SE-RSD-PKM' },
};
for (const k of Object.keys(PRODUCTS)) PRODUCTS[k].img = `assets/products/${k}.jpg`;

// รถเข็นที่ active — ภาพจริงจาก grocery_items, กรอบ = พิกัด normalized (x0, y0, x1, y1) บนภาพเต็ม
const CARTS = [
  { id: 'A-08', status: 'connected', img: 'img-1321', session: '2c9e…5170', started: '14:31', lat: 186, updated: 1,
    items: [['bengbeng_pack12', 1], ['rosdee_mid_pork', 1], ['koalas_march_chocolate', 1]],
    boxes: [[.36, .25, .53, .46, 'bengbeng_pack12', .96, 'p'], [.55, .32, .67, .46, 'rosdee_mid_pork', .90, 's'], [.37, .50, .50, .64, 'koalas_march_chocolate', .91, 'p']],
    events: [['14:31:40', 'ADD', 'bengbeng_pack12', '+1'], ['14:33:12', 'ADD', 'rosdee_mid_pork', '+1'], ['14:35:30', 'ADD', 'lay_big_nori', '+1'], ['14:36:15', 'REMOVE', 'lay_big_nori', '−1'], ['14:38:02', 'ADD', 'koalas_march_chocolate', '+1']] },
  { id: 'A-03', status: 'updating', img: 'img-1', session: '3b9a…1180', started: '14:28', lat: 204, updated: 1,
    alert: ['warn', 'LOW_CONF · lay_big_ori / lay_party_ori สับสน conf 0.58'],
    items: [['lay_big_ori', 1], ['lay_party_ori', 1]],
    boxes: [[.27, .53, .50, .99, 'lay_big_ori', .91, 'p'], [.48, .53, .75, .86, 'lay_party_ori', .58, 'w']],
    outside: [[.80, .08, .875, .21, 'lay_big_ori', .82]] },
  { id: 'B-01', status: 'connected', img: 'img-1001', session: 'c41d…5521', started: '14:20', lat: 171, updated: 2,
    items: [['doritos_mid_nacho', 1], ['lay_big_ori', 1]],
    boxes: [[.53, .19, .73, .34, 'doritos_mid_nacho', .97, 's'], [.54, .34, .75, .51, 'lay_big_ori', .95, 'p']] },
  { id: 'B-03', status: 'disconnected', img: 'img-941', session: 'd17e…3390', started: '14:12', lat: null, updated: 45, offline: true,
    alert: ['err', 'DISCONNECTED · ไม่มีเฟรมเข้ามา 45 วินาที'],
    items: [['mama_cup_ok_hotKR', 1]],
    boxes: [[.69, .49, .83, .70, 'mama_cup_ok_hotKR', .93, 'p']] },
  { id: 'A-12', status: 'connected', img: 'img-1371', session: '6fa2…0824', started: '14:05', lat: 342, updated: 1,
    alert: ['warn', 'HIGH_LATENCY · p95 342 ms > 300 ms'],
    items: [['bengbeng_pack12', 1], ['rosdee_mid_pork', 1], ['koalas_march_chocolate', 1]],
    boxes: [[.33, .39, .49, .61, 'bengbeng_pack12', .95, 'p'], [.57, .33, .63, .46, 'rosdee_mid_pork', .92, 's'], [.54, .52, .68, .66, 'koalas_march_chocolate', .89, 'p']] },
  { id: 'C-02', status: 'connected', img: 'img-481', session: '9d40…2271', started: '14:40', lat: 158, updated: 1,
    items: [['lay_big_nori', 1]],
    boxes: [[.29, .72, .54, .995, 'lay_big_nori', .96, 's']] },
];

// model_versions — mAP50-95 และ latency p95 จริงจาก Desktop\SNP (test 139 ภาพ, RTX 5090)
const MODELS = [
  { name: 'yolo11s-s0-20261025', family: 'YOLO11', size: 's', format: 'pt', map: .916, p95: 4.20, params: '9.43M', gflops: 21.7 },
  { name: 'yolo12s-s0-20261025', family: 'YOLO12', size: 's', format: 'pt', map: .916, p95: 5.81, params: '9.26M', gflops: 23.5 },
  { name: 'yolov10s-s0-20261025', family: 'YOLOv10', size: 's', format: 'pt', map: .913, p95: 4.63, params: '8.07M', gflops: 24.9 },
  { name: 'yolov13s-s0-20261025', family: 'YOLOv13', size: 's', format: 'pt', map: .911, p95: 8.79, params: '9.56M', gflops: 21.7 },
  { name: 'yolov8s-s0-20261025', family: 'YOLOv8', size: 's', format: 'pt', map: .894, p95: 3.45, params: '11.14M', gflops: 28.7 },
  { name: 'yolo26s-s0-20261025', family: 'YOLO26', size: 's', format: 'pt', map: .894, p95: 5.56, params: '9.96M', gflops: 22.8 },
  { name: 'yolov5su-s0-20261025', family: 'YOLOv5', size: 'su', format: 'pt', map: .885, p95: 4.20, params: '9.13M', gflops: 24.1 },
  { name: 'yolov6s-s0-20261025', family: 'YOLOv6', size: 's', format: 'pt', map: .868, p95: 4.15, params: '20.10M', gflops: null },
  { name: 'yolov7-tiny-s0-20261025', family: 'YOLOv7', size: 'tiny', format: 'pt', map: .767, p95: 3.62, params: '6.03M', gflops: null },
  { name: 'yolov4-s0-20261025', family: 'YOLOv4', size: '—', format: 'weights', map: .280, p95: 6.44, params: '—', gflops: null },
];

const MODEL_HISTORY = [
  { at: '25 ต.ค. 22:10', from: 'yolov8s-s0-20261025', to: 'yolo11s-s0-20261025', by: 'สมชาย (admin)', result: 'สำเร็จ · 18 วิ', tone: 'success' },
  { at: '22 ต.ค. 10:02', from: 'yolov5su-s0-20261025', to: 'yolov8s-s0-20261025', by: 'สมชาย (admin)', result: 'สำเร็จ · 21 วิ', tone: 'success' },
  { at: '20 ต.ค. 15:40', from: 'yolov8s-s0-20261025', to: 'yolov5su-s0-20261025', by: 'ระบบ (auto)', result: 'ย้อนกลับ · p95 สูง', tone: 'warning' },
];

const SESSIONS = [
  ['8f1c…0742', 'A-07', '14:32', '10:12', 7, 201, null, 'active'],
  ['2c9e…5170', 'A-08', '14:31', '11:02', 3, 106, null, 'active'],
  ['3b9a…1180', 'A-03', '14:28', '14:05', 2, 104, null, 'active'],
  ['c41d…5521', 'B-01', '14:20', '22:31', 2, 65, null, 'active'],
  ['77ae…0913', 'A-11', '13:58', '12:40', 9, 412, 447, 'checked_out'],
  ['e02f…3304', 'A-02', '13:41', '08:15', 4, 163, 163, 'checked_out'],
  ['91bc…7710', 'B-02', '13:30', '21:52', 0, 0, null, 'abandoned'],
  ['5d62…2048', 'A-05', '13:12', '11:03', 5, 188, 188, 'checked_out'],
  ['a8f0…6631', 'C-01', '12:55', '30:00', 2, 45, null, 'timeout'],
  ['0c7e…9902', 'A-09', '12:40', '09:47', 8, 301, 301, 'checked_out'],
];

const SESSION_EVENTS = {
  '8f1c…0742': [
    ['14:32:05', 'START', null, 'เริ่ม session · สแกน QR รถเข็น A-07', 'source: customer'],
    ['14:32:18', 'ADD', 'lay_big_ori', 'เลย์ รสดั้งเดิม ห่อใหญ่ +1', 'conf 0.93 · auto'],
    ['14:33:02', 'ADD', 'lay_big_ori', 'เลย์ รสดั้งเดิม ห่อใหญ่ +1', 'conf 0.91 · auto'],
    ['14:34:40', 'ADD', 'pringles_norm_ori', 'พริงเกิลส์ รสดั้งเดิม +1', 'conf 0.97 · auto'],
    ['14:36:11', 'ADD', 'lay_big_nori', 'เลย์ รสโนริสาหร่าย ห่อใหญ่ +1', 'conf 0.89 · auto'],
    ['14:36:52', 'REMOVE', 'lay_big_nori', 'เลย์ รสโนริสาหร่าย ห่อใหญ่ −1', 'อยู่ในรถเข็น 41 วิ ก่อนถูกนำออก'],
    ['14:38:27', 'ADD', 'mama_cup_ok_cheeseGo', 'มาม่า คัพ OK ชีสโก +3', 'conf 0.88 · auto'],
    ['14:40:10', 'CORRECTION', 'mama_cup_ok_cheeseGo', 'ลูกค้าแจ้ง “จำนวนไม่ถูกต้อง”', 'source: customer · user_feedback #312'],
    ['14:41:03', 'ADD', 'koalas_march_chocolate', 'โคอะลา มาร์ช ช็อกโกแลต +1', 'conf 0.91 · auto'],
  ],
};

const ALERTS = [
  ['DISCONNECTED', 'danger', 'B-03 ขาดการเชื่อมต่อ 45 วิ', '14:41'],
  ['LOW_CONF', 'warning', 'A-03 · lay_big_ori/lay_party_ori conf 0.58', '14:39'],
  ['HIGH_LATENCY', 'warning', 'A-12 · p95 342 ms เกินเกณฑ์ 300 ms', '14:35'],
  ['CHECKOUT_MISMATCH', 'primary', 'A-11 · ยอดต่างจาก POS ฿35.00', '14:20'],
];

const LATENCY = [
  ['Queue (รอคิว)', 4, 18, 41],
  ['Inference (TensorRT)', 9, 14, 22],
  ['Tracker', 1, 2, 4],
  ['DB write (SQLite)', 3, 9, 21],
  ['Network (RTT)', 118, 225, 336],
];

const ACCOUNTS = {
  'admin@smartcart.co.th': { password: 'admin1234', name: 'สมชาย ใจดี', initials: 'สจ', role: 'admin' },
  'staff@smartcart.co.th': { password: 'staff1234', name: 'วิภา ร้านดี', initials: 'วร', role: 'staff' },
};
