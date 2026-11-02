'use strict';
/* Smart Cart — clickable prototype (ยังไม่ต่อ backend; ข้อมูลจำลองจาก data.js) */

// ---------- icons (lucide-style, ชุดเดียวกับ Figma) ----------
const ICON = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  live: '<path d="M16 13l5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  model: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
  session: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  product: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  latency: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  qr: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M16 12h1"/><path d="M12 21v-1"/>',
  alert: '<path d="M21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  close: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  wifioff: '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="M2 2l20 20"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-.76c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
  rollback: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  box: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
};
const ic = (n, s = 20) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

// ---------- utils ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const baht = n => '฿' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const badge = (tone, label) => `<span class="badge b-${tone}">${esc(label)}</span>`;
const btn = (variant, size, label, attrs = '', icon = '') => `<button class="btn btn-${variant} btn-${size}" ${attrs}>${icon ? ic(icon, size === 'l' ? 20 : 16) : ''}${esc(label)}</button>`;
// staff: ปุ่ม disabled + tooltip
const lockedBtn = (variant, size, label, tipText, icon = '') => `<span class="tip" data-tip="${esc(tipText)}" tabindex="0">${btn(variant, size, label, 'disabled aria-disabled="true"', icon)}</span>`;
const pill = st => ({
  connected: `<span class="pill pill-connected"><span class="dot"></span>เชื่อมต่อแล้ว · อัปเดตสด</span>`,
  updating: `<span class="pill pill-updating"><span class="dot"></span>กำลังตรวจสอบ…</span>`,
  disconnected: `<span class="pill pill-disconnected">${ic('wifioff', 14)}ขาดการเชื่อมต่อ</span>`,
}[st]);

function toast(tone, msg) {
  const tones = { success: ['b-success', 'check'], warning: ['b-warning', 'alert'], danger: ['b-danger', 'alert'], info: ['b-primary', 'info'] };
  const [cls, icn] = tones[tone] || tones.info;
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="tile ${cls}">${ic(icn, 18)}</span><span class="grow">${esc(msg)}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---------- state ----------
const INITIAL_CART = () => [
  { cls: 'lay_big_ori', qty: 2, state: '' },
  { cls: 'pringles_norm_ori', qty: 1, state: '' },
  { cls: 'mama_cup_ok_cheeseGo', qty: 3, state: '' },
  { cls: 'koalas_march_chocolate', qty: 1, state: '' },
];
const state = {
  pdpa: false, gender: null, age: null,
  cart: { status: 'connected', pending: false, items: INITIAL_CART(), sheet: false, issue: 'wrong_qty', issueProduct: 'mama_cup_ok_cheeseGo', lastSync: '14:41:05' },
  checkoutUntil: 0,
  user: null, loginEmail: 'admin@smartcart.co.th', loginPw: '', loginErr: false, attempts: 3,
  range: 1, liveFilter: 'all', toggles: { boxes: true, roi: true, outside: false },
  activeModel: 'yolo11s-s0-20261025', modelModal: null, modelProgress: null, history: MODEL_HISTORY.slice(),
  selSession: SESSIONS[0][0],
  editProduct: 'lay_party_ori',
  priceHist: { lay_party_ori: [['฿69.00', '1 ต.ค. 2026 – ปัจจุบัน', true], ['฿65.00', '1 ก.ค. – 30 ก.ย. 2026'], ['฿62.00', '1 ม.ค. – 30 มิ.ย. 2026']] },
  latWin: 1, bell: false,
};
const isStaff = () => state.user && state.user.role === 'staff';
const cartCount = () => state.cart.items.filter(i => i.state !== 'removed').reduce((s, i) => s + i.qty, 0);
const cartTotal = () => state.cart.items.filter(i => i.state !== 'removed').reduce((s, i) => s + PRODUCTS[i.cls].price * i.qty, 0);
const nowTime = () => new Date().toLocaleTimeString('en-GB');

// =====================================================================
// CUSTOMER
// =====================================================================
const C_SCREENS = [
  ['/', 'C-00 เลือกบทบาท'], ['/c/scan', 'C-01 สแกน QR'], ['/c/welcome', 'C-02 ต้อนรับ + PDPA'],
  ['/c/gender', 'C-03 ข้อมูล 1/2 · เพศ'], ['/c/age', 'C-04 ข้อมูล 2/2 · อายุ'], ['/c/cart', 'C-05 ตะกร้า real-time'],
  ['/c/summary', 'C-07 สรุปยอด + QR'], ['/c/error-qr', 'C-08 QR ไม่ถูกต้อง'], ['/c/error-busy', 'C-09 รถเข็นถูกใช้อยู่'],
];
function protoPanel(path) {
  const ctl = (act, label) => `<button class="btn btn-secondary btn-m btn-block" data-act="${act}">${label}</button>`;
  return `<aside class="proto-panel" aria-label="แผงควบคุม prototype">
    <div class="card"><span class="t-h3">หน้าจอลูกค้า</span>
      ${C_SCREENS.map(([p, l]) => `<a class="link ${p === path ? 'on' : ''}" href="#${p}">${l}</a>`).join('')}
    </div>
    <div class="card"><span class="t-h3">จำลองระบบ real-time</span>
      <span class="t-cap muted">จำลองข้อความ cart_update จาก server</span>
      ${ctl('sim-add', '＋ วางสินค้าลงตะกร้า (ADD)')}
      ${ctl('sim-remove', '－ หยิบสินค้าออก (REMOVE)')}
      ${ctl('sim-net', state.cart.status === 'disconnected' ? 'เชื่อมต่อใหม่' : 'ตัดการเชื่อมต่อ')}
      ${ctl('sim-empty', 'ล้างตะกร้า (สถานะว่าง)')}
      ${ctl('sim-reset', 'คืนค่าเริ่มต้น')}
    </div>
    <div class="card"><span class="t-h3">ฝั่งผู้ดูแล</span><a class="link" href="#/a/login">เปิด Admin Login →</a></div>
  </aside>`;
}
function cShell(path, inner, { dark = false, overlay = '' } = {}) {
  return `<div class="c-stage"><div class="phone ${dark ? 'dark' : ''}">
    <div class="statusbar"><span>9:41</span><span>5G · 100%</span></div>${inner}${overlay}
  </div>${protoPanel(path)}</div>`;
}

function viewRole() {
  return cShell('/', `<div class="c-body"><div class="c-pad" style="flex:1">
    <div class="row gap-12"><div class="logo-mark">${ic('cart', 26)}</div><span class="t-h2">Smart Cart</span></div>
    <div class="col gap-8"><h1 class="t-h1">ยินดีต้อนรับ</h1><p class="t-body-l muted" style="margin:0">เลือกวิธีเข้าใช้งานระบบรถเข็นอัจฉริยะ</p></div>
    <a class="card role-card" href="#/c/scan"><div class="icon-tile">${ic('qr', 24)}</div>
      <div class="col gap-4"><span class="t-h3">ลูกค้า (สแกน QR)</span><span class="muted">สแกน QR บนด้ามจับรถเข็น เพื่อดูรายการสินค้าและราคารวมแบบเรียลไทม์</span></div></a>
    <a class="card role-card" href="#/a/login"><div class="icon-tile">${ic('shield', 24)}</div>
      <div class="col gap-4"><span class="t-h3">ผู้ดูแลระบบ (เข้าสู่ระบบ)</span><span class="muted">ดูรถเข็นสด วิเคราะห์การหยิบเข้า–ออก จัดการโมเดลและราคา</span></div></a>
    <div class="spacer"></div>
    <p class="t-cap muted center" style="margin:0">ระบบไม่บันทึกภาพใบหน้า กล้องมองเฉพาะภายในตะกร้า (PDPA)</p>
  </div></div>`);
}

function viewScan() {
  return cShell('/c/scan', `
    <div class="c-top"><a class="icon-btn bare" href="#/" aria-label="ย้อนกลับ" style="color:#fff">${ic('back', 24)}</a><span class="t-h3">สแกน QR บนรถเข็น</span></div>
    <div class="scan-area">
      <div class="scan-bg" style="background-image:url('assets/camera/img-1321.jpg')"></div>
      <button class="viewfinder" data-act="scan-ok" aria-label="แตะเพื่อจำลองการสแกนสำเร็จ"><span class="scanline"></span>${ic('qr', 72)}</button>
      <p class="center" style="position:relative;margin:0">วาง QR บนด้ามจับรถเข็นให้อยู่ในกรอบ<br><span class="t-cap" style="opacity:.75">แตะกรอบเพื่อจำลองการสแกน</span></p>
    </div>
    <div class="c-bottom"><a class="btn btn-secondary btn-l btn-block" href="#/c/welcome">กรอกรหัสรถเข็นเอง</a></div>`, { dark: true });
}

function viewWelcome() {
  const hl = ['กล้องมองเฉพาะภายในตะกร้า ไม่บันทึกใบหน้า', 'แจ้งได้ทันทีหากรายการไม่ถูกต้อง', 'ชำระเงินที่แคชเชียร์ด้วย QR สรุปยอด'];
  return cShell('/c/welcome', `<div class="c-body"><div class="c-pad" style="flex:1">
      <div>${badge('primary', 'รถเข็น #A-07 · สาขาลาดพร้าว')}</div>
      <div class="illus">${ic('cart', 44)}</div>
      <div class="col gap-8"><h1 class="t-h1">สวัสดี! รถเข็น A-07 พร้อมใช้งาน</h1>
        <p class="t-body-l muted" style="margin:0">วางสินค้าลงในตะกร้าได้ทันที ระบบจะแสดงรายการและราคารวมให้อัตโนมัติ ไม่ต้องสแกนบาร์โค้ด</p></div>
      <div class="col gap-12">${hl.map(t => `<div class="row gap-12"><span class="check-dot">${ic('check', 14)}</span><span>${t}</span></div>`).join('')}</div>
      <div class="spacer"></div>
      <label class="checkbox"><input type="checkbox" data-change="pdpa" ${state.pdpa ? 'checked' : ''}><span class="box">${ic('check', 14)}</span>
        <span>ฉันยินยอมให้เก็บข้อมูลการซื้อแบบไม่ระบุตัวตน เพื่อวิเคราะห์และปรับปรุงบริการ ตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล (PDPA) · <a href="#/c/welcome" style="color:var(--primary);font-weight:600">อ่านนโยบาย</a></span></label>
    </div></div>
    <div class="c-bottom"><button id="start" class="btn btn-primary btn-l btn-block" data-act="go" data-to="#/c/gender" ${state.pdpa ? '' : 'disabled'}>เริ่มช้อปปิ้ง</button></div>`);
}

function surveyView(path, step, key, title, desc, opts, cols, next, cta) {
  const optHtml = opts.map(o => `<button class="option ${state[key] === o ? 'on' : ''}" data-act="pick" data-key="${key}" data-val="${esc(o)}" aria-pressed="${state[key] === o}"><span class="radio"></span>${esc(o)}</button>`).join('');
  return cShell(path, `
    <div class="c-top"><a class="icon-btn bare" href="${step === 1 ? '#/c/welcome' : '#/c/gender'}" aria-label="ย้อนกลับ">${ic('back', 24)}</a>
      <span class="t-label muted grow">ขั้นที่ ${step} จาก 2</span><a class="btn btn-ghost btn-m" href="${next}">ข้าม</a></div>
    <div class="progress"><span class="on"></span><span class="${step === 2 ? 'on' : ''}"></span></div>
    <div class="c-body"><div class="c-pad" style="padding:32px 16px 16px">
      <div class="col gap-8"><h1 class="t-h1">${title}</h1><p class="muted" style="margin:0">${desc}</p></div>
      <div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:12px">${optHtml}</div>
    </div></div>
    <div class="c-bottom" style="padding:8px 16px 40px"><a class="btn btn-primary btn-l btn-block" href="${next}">${cta}</a></div>`);
}
const viewGender = () => surveyView('/c/gender', 1, 'gender', 'เพศของคุณ', 'ใช้วิเคราะห์ภาพรวมของร้านแบบไม่ระบุตัวตน ข้ามได้หากไม่ต้องการตอบ', ['ชาย', 'หญิง', 'อื่น ๆ', 'ไม่ระบุ'], 1, '#/c/age', 'ถัดไป');
const viewAge = () => surveyView('/c/age', 2, 'age', 'ช่วงอายุของคุณ', 'เลือกช่วงที่ใกล้เคียงที่สุด ข้อมูลนี้ไม่ผูกกับตัวตนของคุณ', ['ต่ำกว่า 18', '18–24', '25–34', '35–44', '45–54', '55–64', '65 ขึ้นไป', 'ไม่ระบุ'], 2, '#/c/cart', 'เริ่มช้อปปิ้ง');

function productRow(it) {
  const p = PRODUCTS[it.cls];
  const note = it.state === 'added' ? `<span class="t-cap-strong" style="color:var(--success-text)">+1 เพิ่งเพิ่ม</span>`
    : it.state === 'removed' ? `<span class="t-cap-strong" style="color:var(--danger)">นำออกจากตะกร้าแล้ว</span>` : '';
  return `<div class="p-row ${it.state}"><img class="thumb" src="${p.img}" alt="${esc(p.name)}">
    <div class="grow col"><span class="name t-strong">${esc(p.name)}</span><span class="t-cap muted">${baht(p.price)} / ชิ้น</span>${note}</div>
    <span class="t-label muted num">× ${it.qty}</span><span class="sub t-strong num">${baht(p.price * it.qty)}</span></div>`;
}

function viewCart() {
  const c = state.cart, n = cartCount(), total = cartTotal();
  const live = c.items;
  let banner = '';
  if (c.status === 'updating') banner = `<div class="banner warn">${ic('info', 20)}<div class="col"><span class="title t-strong">กำลังตรวจสอบสินค้า…</span><span class="t-cap">ระบบรอให้ผลตรวจจับนิ่งก่อน (~2 วินาที) ราคาจะไม่เปลี่ยนไปมา</span></div></div>`;
  if (c.status === 'disconnected') banner = `<div class="banner err">${ic('wifioff', 20)}<div class="col"><span class="title t-strong">ขาดการเชื่อมต่อ กำลังเชื่อมต่อใหม่…</span><span class="t-cap">แสดงรายการล่าสุดเมื่อ ${c.lastSync} รายการไม่ถูกล้าง</span></div></div>`;
  const empty = !live.length && !c.pending;
  const list = empty
    ? `<div class="empty"><div class="illus" style="width:112px;height:112px">${ic('cart', 48)}</div><span class="t-h3">ยังไม่มีสินค้าในตะกร้า</span><span class="muted">วางสินค้าลงในตะกร้าได้เลย ระบบจะเพิ่มรายการและราคาให้อัตโนมัติภายในประมาณ 2 วินาที</span></div>`
    : live.map(productRow).join('') + (c.pending ? `<div class="p-row skeleton"><div class="thumb sk"></div><div class="grow col gap-8"><div class="sk" style="width:180px;height:10px"></div><div class="sk" style="width:110px;height:10px"></div><span class="t-cap-strong" style="color:var(--warning-text)">กำลังตรวจสอบสินค้าที่เพิ่งวาง…</span></div></div>` : '');
  const dim = c.status !== 'connected';
  const overlay = c.sheet ? reportSheet() : '';
  return cShell('/c/cart', `
    <div class="c-head"><div class="grow col"><span class="t-h2">รถเข็น A-07</span><span class="t-cap muted">เริ่ม 14:32 · ${n} ชิ้น</span></div>${pill(c.status)}</div>
    ${banner}
    <div class="list-head"><span class="t-strong grow">รายการสินค้า (${live.filter(i => i.state !== 'removed').length})</span><span class="t-cap muted">จำนวน · รวมย่อย</span></div>
    <div class="item-list">${list}</div>
    <div class="c-bar">
      <div class="row" style="align-items:flex-end"><div class="grow col"><span class="t-strong muted">ราคารวม</span>
        <span class="t-cap" style="color:${c.status === 'updating' ? 'var(--warning-text)' : 'var(--text-2)'}">${c.status === 'updating' ? 'รอระบบยืนยันรายการล่าสุด' : `${n} ชิ้น · รวม VAT แล้ว`}</span></div>
        <span class="t-price" style="color:${dim ? 'var(--text-2)' : 'var(--text)'}" aria-live="polite">${baht(total)}</span></div>
      <div class="actions">${btn('secondary', 'l', 'รายการไม่ถูกต้อง', 'data-act="sheet-open"')}${btn('primary', 'l', 'จบการซื้อ', `data-act="checkout" ${n === 0 || c.status === 'disconnected' ? 'disabled' : ''}`)}</div>
    </div>`, { overlay });
}

function reportSheet() {
  const c = state.cart;
  const issues = [['missing', 'สินค้าขาดหายไป (มีของแต่ไม่แสดง)'], ['extra', 'มีรายการเกิน (ไม่ได้หยิบ)'], ['wrong_class', 'ชื่อสินค้าไม่ถูกต้อง'], ['wrong_qty', 'จำนวนไม่ถูกต้อง']];
  const opts = Object.entries(PRODUCTS).map(([k, p]) => `<option value="${k}" ${k === c.issueProduct ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  return `<div class="sheet-wrap" data-act="sheet-close-bg"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
    <div class="grabber"></div>
    <div class="col gap-4"><span id="sheet-title" class="t-h2">แจ้งรายการไม่ถูกต้อง</span><span class="muted">ระบบจะบันทึกภาพเฟรมนี้เพื่อนำไปปรับปรุงโมเดล</span></div>
    <div class="col gap-8">${issues.map(([k, l]) => `<button class="option ${c.issue === k ? 'on' : ''}" data-act="issue" data-val="${k}"><span class="radio"></span>${l}</button>`).join('')}</div>
    <div class="field"><label for="issue-product">สินค้าที่เกี่ยวข้อง (ไม่บังคับ)</label>
      <div class="input">${ic('product')}<select id="issue-product" data-change="issueProduct">${opts}</select></div></div>
    <div class="row gap-12">${btn('secondary', 'l', 'ยกเลิก', 'data-act="sheet-close" style="flex:1"')}${btn('primary', 'l', 'ส่งแจ้งปัญหา', 'data-act="sheet-submit" style="flex:1"')}</div>
  </div></div>`;
}

function qrSvg(size = 150) {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const N = 25, m = size / N; let d = '';
  const finder = (x, y) => [[0, 0], [N - 7, 0], [0, N - 7]].find(([a, c]) => x >= a && x < a + 7 && y >= c && y < c + 7);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const f = finder(x, y); let on;
    if (f) { const u = x - f[0], v = y - f[1]; on = u === 0 || u === 6 || v === 0 || v === 6 || (u >= 2 && u <= 4 && v >= 2 && v <= 4); } else on = rnd() < 0.47;
    if (on) d += `M${(x * m).toFixed(2)} ${(y * m).toFixed(2)}h${m.toFixed(2)}v${m.toFixed(2)}h-${m.toFixed(2)}z`;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR สำหรับพนักงาน"><path d="${d}" fill="#0F172A"/></svg>`;
}
function countdownText() {
  const s = Math.max(0, Math.round((state.checkoutUntil - Date.now()) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function viewSummary() {
  if (!state.checkoutUntil) state.checkoutUntil = Date.now() + 600000;
  const items = state.cart.items.filter(i => i.state !== 'removed');
  return cShell('/c/summary', `
    <div class="c-top"><a class="icon-btn bare" href="#/c/cart" aria-label="กลับไปที่ตะกร้า">${ic('back', 24)}</a><span class="t-h3">สรุปยอดการซื้อ</span></div>
    <div class="c-body"><div class="col gap-16" style="padding:8px 16px 16px">
      <div class="card col gap-12" style="padding:24px;align-items:center">${qrSvg()}
        <span class="t-strong center">แสดง QR นี้ให้พนักงานที่จุดชำระเงิน</span><span class="t-label muted">SC-8F1C-0742</span>
        <span class="badge b-warning">หมดอายุใน <span data-countdown>${countdownText()}</span></span></div>
      <div class="card col gap-8" style="padding:16px">
        ${items.map(i => `<div class="row"><span class="grow">${esc(PRODUCTS[i.cls].name)}</span><span class="muted">×${i.qty}</span><span class="t-strong num">${baht(PRODUCTS[i.cls].price * i.qty)}</span></div>`).join('')}
        <div style="height:1px;background:var(--border);margin:4px 0"></div>
        <div class="row"><span class="t-strong muted grow">ราคารวม (${cartCount()} ชิ้น)</span><span class="t-price">${baht(cartTotal())}</span></div>
      </div>
      <p class="t-cap muted center" style="margin:0">ยอดจากระบบอาจได้รับการตรวจสอบโดยพนักงานก่อนชำระเงิน</p>
    </div></div>
    <div class="c-bottom" style="padding:8px 16px 40px"><a class="btn btn-secondary btn-l btn-block" href="#/c/cart">กลับไปที่ตะกร้า</a></div>`);
}

function errorView(path, icon, tone, title, body, code, primaryLabel, ghostLabel) {
  const bg = tone === 'danger' ? 'var(--danger-subtle)' : 'var(--warning-subtle)';
  const fg = tone === 'danger' ? 'var(--danger)' : 'var(--warning-text)';
  return cShell(path, `<div class="c-body"><div class="empty" style="gap:16px">
      <div class="illus" style="background:${bg};color:${fg}">${ic(icon, 44)}</div>
      <h1 class="t-h1">${title}</h1><p class="t-body-l muted" style="margin:0">${body}</p>${badge('neutral', 'รหัส: ' + code)}
    </div></div>
    <div class="c-bottom"><a class="btn btn-primary btn-l btn-block" href="#/c/scan">${primaryLabel}</a><button class="btn btn-ghost btn-l btn-block" data-act="call-staff">${ghostLabel}</button></div>`);
}
const viewErrQr = () => errorView('/c/error-qr', 'qr', 'danger', 'QR ไม่ถูกต้อง', 'QR นี้ไม่ใช่รหัสรถเข็นของ Smart Cart หรือหมดอายุแล้ว ลองสแกน QR ที่ด้ามจับรถเข็นอีกครั้ง', 'INVALID_QR', 'สแกนอีกครั้ง', 'ติดต่อพนักงาน');
const viewErrBusy = () => errorView('/c/error-busy', 'cart', 'warning', 'รถเข็น A-07 กำลังถูกใช้งาน', 'รถเข็นคันนี้มี session ที่ยังไม่จบ หากเป็นของคุณให้กลับไปที่หน้าจอเดิม หรือเลือกรถเข็นคันอื่น', 'CART_IN_USE', 'สแกนรถเข็นคันอื่น', 'แจ้งพนักงานให้รีเซ็ต');

// ---------- real-time simulation ----------
const POOL = ['lay_big_nori', 'doritos_mid_nacho', 'bengbeng_pack12', 'rosdee_mid_pork', 'kohkae_small_wasabi', 'mama_cup_ok_hotKR', 'lay_party_ori', 'lay_big_ori'];
let poolIdx = 0;
function simAdd() {
  const c = state.cart;
  if (c.status === 'disconnected') { toast('warning', 'ขาดการเชื่อมต่ออยู่ ระบบยังรับรายการใหม่ไม่ได้'); return; }
  if (c.pending) return;
  c.status = 'updating'; c.pending = true; render();
  setTimeout(() => {
    const cls = POOL[poolIdx++ % POOL.length];
    let it = c.items.find(i => i.cls === cls && i.state !== 'removed');
    if (it) { it.qty += 1; it.state = 'added'; } else { it = { cls, qty: 1, state: 'added' }; c.items.unshift(it); }
    c.pending = false; c.status = 'connected'; c.lastSync = nowTime(); render();
    setTimeout(() => { if (it.state === 'added') { it.state = ''; render(); } }, 2000);
  }, 1800);
}
function simRemove() {
  const c = state.cart;
  if (c.status === 'disconnected') { toast('warning', 'ขาดการเชื่อมต่ออยู่ รายการล่าสุดถูกแสดงค้างไว้'); return; }
  const it = c.items.find(i => i.state !== 'removed');
  if (!it) { toast('info', 'ตะกร้าว่างอยู่แล้ว'); return; }
  if (it.qty > 1) {
    // แยกชิ้นที่ถูกหยิบออกเป็นแถวขีดฆ่าชั่วคราว แล้วลดจำนวนในแถวเดิม
    const ghost = { cls: it.cls, qty: 1, state: 'removed' };
    it.qty -= 1; c.items.splice(c.items.indexOf(it) + 1, 0, ghost); render();
    setTimeout(() => { c.items = c.items.filter(x => x !== ghost); render(); }, 1500);
  } else {
    it.state = 'removed'; render();
    setTimeout(() => { c.items = c.items.filter(x => x !== it); render(); }, 1500);
  }
}

// =====================================================================
// ADMIN
// =====================================================================
const NAV = [
  ['dashboard', 'Dashboard', 'dashboard'], ['live', 'Live รถเข็น', 'live'], ['models', 'โมเดล', 'model', true],
  ['sessions', 'Sessions', 'session'], ['products', 'สินค้าและราคา', 'product', true], ['latency', 'Latency', 'latency'],
];
function aShell(active, inner) {
  const u = state.user;
  const nav = NAV.map(([k, l, icn, adminOnly]) => `<a href="#/a/${k}" class="${active === k ? 'on' : ''}" ${active === k ? 'aria-current="page"' : ''}>${ic(icn)}<span>${l}</span>${adminOnly && isStaff() ? `<span class="lock" title="แก้ไขได้เฉพาะ admin">${ic('lock', 14)}</span>` : ''}</a>`).join('');
  const pop = state.bell ? `<div class="card popover" role="dialog" aria-label="การแจ้งเตือน"><span class="t-strong" style="padding:4px 8px">การแจ้งเตือน</span>
    ${ALERTS.map(([t, tone, msg, tm]) => `<div class="row">${badge(tone, t)}<span class="t-cap grow">${esc(msg)}</span><span class="t-cap muted">${tm}</span></div>`).join('')}</div>` : '';
  return `<div class="a-app">
    <aside class="sidebar">
      <div class="brand"><div class="mark">${ic('cart', 22)}</div><div class="col hide-sm"><span class="t-h3">Smart Cart</span><span class="t-cap muted">Admin console</span></div></div>
      <nav class="nav" aria-label="เมนูหลัก">${nav}</nav>
      <div class="spacer"></div>
      <div class="user-box hide-sm"><div class="avatar">${u.initials}</div><div class="col grow"><span class="t-strong">${u.name}</span><span>${badge(isStaff() ? 'neutral' : 'primary', isStaff() ? 'Staff' : 'Admin')}</span></div></div>
      <nav class="nav"><a href="#/a/login" data-act="logout">${ic('logout')}<span>ออกจากระบบ</span></a></nav>
    </aside>
    <div class="a-main">
      <header class="a-header">
        <label class="search">${ic('search', 18)}<input type="search" placeholder="ค้นหารถเข็น, session หรือสินค้า…" aria-label="ค้นหา"></label>
        <div class="spacer"></div>
        <span class="btn btn-secondary btn-m" style="cursor:default">${ic('box', 18)}สาขาลาดพร้าว</span>
        <div style="position:relative"><button class="icon-btn" data-act="bell" aria-label="การแจ้งเตือน ${ALERTS.length} รายการ" aria-expanded="${state.bell}">${ic('bell')}<span class="count-dot">${ALERTS.length}</span></button>${pop}</div>
      </header>
      <main class="a-content">${inner}</main>
    </div></div>`;
}
const pageTitle = (title, sub, right = '') => `<div class="page-title"><div class="grow col"><h1 class="t-h1">${title}</h1>${sub ? `<span class="muted">${sub}</span>` : ''}</div>${right}</div>`;
const seg = (act, opts, sel) => `<div class="seg" role="tablist">${opts.map((o, i) => `<button role="tab" aria-selected="${i === sel}" class="${i === sel ? 'on' : ''}" data-act="${act}" data-v="${i}">${o}</button>`).join('')}</div>`;
const cardHead = (title, sub, right = '') => `<div class="card-head"><div class="grow col"><span class="t-h3">${title}</span>${sub ? `<span class="t-cap muted">${sub}</span>` : ''}</div>${right}</div>`;

// ---------- login ----------
function viewLogin() {
  const err = state.loginErr, locked = state.attempts <= 0;
  return `<div class="login">
    <section class="brand-panel">
      <div class="row gap-12"><div class="mark">${ic('cart', 24)}</div><span class="t-h2">Smart Cart</span></div>
      <div class="col gap-16"><h1 style="font-size:36px;line-height:48px;margin:0">ระบบผู้ดูแลรถเข็นอัจฉริยะ</h1>
        <p class="t-body-l" style="margin:0;opacity:.85">ติดตามรถเข็นแบบเรียลไทม์ วิเคราะห์การหยิบเข้า–ออก และจัดการโมเดล YOLO กับราคาสินค้าในที่เดียว</p>
        <div class="row wrap gap-12">${['mAP50-95 0.916', 'Latency p95 4.2 ms', '11 สินค้า', 'RTX 5090 benchmark'].map(s => `<span class="stat-chip">${s}</span>`).join('')}</div></div>
      <span class="t-cap" style="opacity:.7">© 2026 Smart Cart YOLO Research · ภาค 2</span>
    </section>
    <section style="display:grid;place-items:center;padding:48px 16px">
      <form class="card login-card" data-submit="login" novalidate>
        <div class="col gap-4"><h1 class="t-h1">เข้าสู่ระบบ</h1><span class="muted">สำหรับผู้ดูแลระบบและพนักงาน (admin / staff)</span></div>
        ${err ? `<div class="err-banner" role="alert">${ic('alert')}<span>${locked ? 'บัญชีถูกล็อก 5 นาที เนื่องจากใส่รหัสผิดหลายครั้ง (จำลอง)' : `อีเมลหรือรหัสผ่านไม่ถูกต้อง เหลือ ${state.attempts} ครั้งก่อนบัญชีถูกล็อก 5 นาที`}</span></div>` : ''}
        <div class="field"><label for="email">อีเมล</label><div class="input ${err ? 'is-error' : ''}">${ic('user')}<input id="email" type="email" autocomplete="username" value="${esc(state.loginEmail)}" data-input="loginEmail">${err ? `<span style="color:var(--danger)">${ic('alert', 18)}</span>` : ''}</div></div>
        <div class="field"><label for="pw">รหัสผ่าน</label><div class="input ${err ? 'is-error' : ''}">${ic('lock')}<input id="pw" type="password" autocomplete="current-password" value="${esc(state.loginPw)}" data-input="loginPw" placeholder="••••••••"></div>
          ${err ? '<span class="helper err">ตรวจสอบรหัสผ่านอีกครั้ง (ตัวพิมพ์ใหญ่–เล็กมีผล)</span>' : ''}</div>
        <div class="row"><label class="checkbox grow"><input type="checkbox" checked><span class="box">${ic('check', 14)}</span><span>จดจำฉันไว้ในอุปกรณ์นี้</span></label>
          <button type="button" class="btn btn-ghost btn-m" data-act="forgot">ลืมรหัสผ่าน?</button></div>
        <button type="submit" class="btn btn-primary btn-l btn-block" ${locked ? 'disabled' : ''}>เข้าสู่ระบบ</button>
        <div class="demo-creds t-cap col gap-4"><span class="t-cap-strong">บัญชีทดลอง (prototype)</span>
          <span>admin: admin@smartcart.co.th / admin1234 · <button type="button" data-act="fill" data-role="admin">ใส่ให้</button></span>
          <span>staff: staff@smartcart.co.th / staff1234 · <button type="button" data-act="fill" data-role="staff">ใส่ให้</button></span></div>
        <span class="t-cap muted">สิทธิ์ของบัญชี (admin / staff) กำหนดโดยผู้ดูแลระบบ · staff ดูข้อมูลได้แต่เปลี่ยนโมเดลและแก้ราคาไม่ได้</span>
        <a class="t-cap" href="#/" style="color:var(--primary)">← กลับไปหน้าเลือกบทบาท</a>
      </form>
    </section></div>`;
}

// ---------- charts ----------
function lineChart({ vals, min, max, yl, xl, w = 640, h = 220, peak, peakLabel, threshold, thLabel, label }) {
  const L = 40, T = 12, B = 26, R = 8, W = w - L - R, H = h - T - B;
  const X = i => L + i * (W / (vals.length - 1)), Y = v => T + H - (v - min) / (max - min) * H;
  const pts = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
  let g = '';
  yl.forEach((l, i) => { const y = T + i * (H / (yl.length - 1)); g += `<line x1="${L}" x2="${L + W}" y1="${y}" y2="${y}" stroke="#E2E8F0"/><text x="${L - 8}" y="${y + 4}" text-anchor="end">${l}</text>`; });
  xl.forEach((l, i) => { g += `<text x="${L + i * (W / (xl.length - 1))}" y="${h - 6}" text-anchor="middle">${l}</text>`; });
  let extra = '';
  if (threshold != null) { const y = Y(threshold); extra += `<line x1="${L}" x2="${L + W}" y1="${y}" y2="${y}" stroke="#DC2626" stroke-width="1.5" stroke-dasharray="6 4"/><rect x="${L + 6}" y="${y - 22}" width="92" height="18" rx="4" fill="#FEF2F2"/><text x="${L + 12}" y="${y - 9}" style="fill:#DC2626;font-weight:600">${thLabel}</text>`; }
  if (peak != null) { const x = X(peak), y = Y(vals[peak]); const tx = clamp(x - 70, L, L + W - 140); extra += `<circle cx="${x}" cy="${y}" r="5" fill="#fff" stroke="${threshold != null ? '#DC2626' : '#2563EB'}" stroke-width="2.5"/><rect x="${tx}" y="${Math.max(0, y - 36)}" width="140" height="24" rx="6" fill="#0F172A"/><text x="${tx + 70}" y="${Math.max(0, y - 36) + 16}" text-anchor="middle" style="fill:#fff;font-weight:600">${peakLabel}</text>`; }
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(label)}">${g}
    <polygon points="${L},${T + H} ${pts.join(' ')} ${L + W},${T + H}" fill="#2563EB" fill-opacity=".1"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="#2563EB" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${extra}</svg>`;
}
function scatterChart(models, active) {
  const w = 300, h = 220, L = 36, T = 10, B = 26, R = 10, W = w - L - R, H = h - T - B;
  const x0 = 3, x1 = 9, y0 = .75, y1 = .93;
  const X = v => L + (v - x0) / (x1 - x0) * W, Y = v => T + H - (v - y0) / (y1 - y0) * H;
  const vis = models.filter(m => m.map >= y0);
  const sorted = vis.slice().sort((a, b) => a.p95 - b.p95 || b.map - a.map);
  const front = []; let best = -1; for (const m of sorted) if (m.map > best) { front.push(m); best = m.map; }
  let g = '';
  [.93, .87, .81, .75].forEach(v => { g += `<line x1="${L}" x2="${L + W}" y1="${Y(v)}" y2="${Y(v)}" stroke="#E2E8F0"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${v.toFixed(2)}</text>`; });
  [3, 5, 7, 9].forEach(v => { g += `<text x="${X(v)}" y="${h - 6}" text-anchor="${v === 9 ? 'end' : 'middle'}">${v}${v === 9 ? ' ms' : ''}</text>`; });
  const fp = front.map(m => `${X(m.p95).toFixed(1)},${Y(m.map).toFixed(1)}`);
  g += `<polyline points="${fp.join(' ')} ${L + W},${Y(front[front.length - 1].map).toFixed(1)}" fill="none" stroke="#16A34A" stroke-width="1.5" stroke-dasharray="4 4"/>`;
  for (const m of vis) {
    const on = m.name === active, short = m.name.split('-').slice(0, m.name.includes('tiny') ? 2 : 1).join('-').replace('yolov', 'v').replace('yolo', 'v');
    g += `<circle cx="${X(m.p95)}" cy="${Y(m.map)}" r="5" fill="${on ? '#16A34A' : '#2563EB'}" stroke="#fff" stroke-width="2"><title>${m.name} · mAP ${m.map.toFixed(3)} · p95 ${m.p95.toFixed(2)} ms</title></circle>`;
    if (['v11s', 'v8s', 'v12s', 'v13s', 'v7-tiny', 'v6s'].includes(short) || on) g += `<text x="${Math.min(X(m.p95) + 7, L + W - 36)}" y="${Y(m.map) + (short === 'v8s' || short === 'v6s' ? 14 : -7)}" style="font-weight:600;fill:${on ? '#15803D' : '#64748B'}">${short}</text>`;
  }
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="กราฟ mAP50-95 เทียบ latency p95">${g}</svg>`;
}

// ---------- dashboard ----------
const RANGES = [
  { kpi: ['184', '฿179.20', '10:58 นาที', '97.3%'], d: ['+4.1%', '+1.2%', '−1.4%', '+0.5 pt'], f: .14 },
  { kpi: ['1,284', '฿186.50', '11:24 นาที', '96.8%'], d: ['+12.4%', '+3.1%', '−0.8%', '+1.2 pt'], f: 1 },
  { kpi: ['5,402', '฿181.90', '11:40 นาที', '96.1%'], d: ['+8.7%', '+2.0%', '+0.6%', '+0.9 pt'], f: 4.2 },
  { kpi: ['1,284', '฿186.50', '11:24 นาที', '96.8%'], d: ['+12.4%', '+3.1%', '−0.8%', '+1.2 pt'], f: 1 },
];
function viewDashboard() {
  const r = RANGES[state.range];
  const labels = [['Session ทั้งหมด', 'cart', 'เทียบช่วงก่อนหน้า'], ['ยอดเฉลี่ยต่อรถเข็น', 'product', 'ต่อ session'], ['เวลา session เฉลี่ย', 'session', 'ต่อ session'], ['Cart accuracy', 'check', 'รายการตรงกับ POS']];
  const kpis = labels.map(([l, icn, note], i) => {
    const d = r.d[i], tone = i === 2 ? (d.startsWith('−') ? 'success' : 'warning') : 'success';
    return `<div class="card kpi"><div class="row"><span class="t-label muted grow">${l}</span><span class="tile">${ic(icn, 18)}</span></div>
      <span class="t-h1 num">${r.kpi[i]}</span><div class="row">${badge(tone, d)}<span class="t-cap muted">${note}</span></div></div>`;
  }).join('');
  const base = [12, 18, 25, 31, 46, 58, 52, 40, 38, 49, 63, 71, 55, 34, 20];
  const vals = base.map(v => Math.round(v * (state.range === 0 ? 1.05 : 1)));
  const ab = [['lay_party_ori', .31, '42/135'], ['mama_cup_ok_hotKR', .24, '29/121'], ['pringles_norm_ori', .21, '25/119'], ['doritos_mid_nacho', .18, '17/94'], ['bengbeng_pack12', .12, '9/75'], ['koalas_march_chocolate', .09, '8/88']];
  const co = [['lay_big_ori', 'pringles_norm_ori', 142, .11, 1.84], ['mama_cup_ok_cheeseGo', 'mama_cup_ok_hotKR', 118, .09, 2.31], ['lay_big_nori', 'kohkae_small_wasabi', 96, .07, 1.52], ['doritos_mid_nacho', 'lay_party_ori', 81, .06, 1.37]];
  return aShell('dashboard', `
    ${pageTitle('Dashboard', 'ภาพรวมร้าน · สาขาลาดพร้าว · อัปเดตล่าสุด 14:42', seg('range', ['วันนี้', '7 วัน', '30 วัน', 'กำหนดเอง'], state.range) + `<span class="btn btn-secondary btn-m" style="cursor:default">${ic('calendar', 16)}${['27 ต.ค. 2026', '21–27 ต.ค. 2026', '28 ก.ย.–27 ต.ค. 2026', '21–27 ต.ค. 2026'][state.range]}</span>`)}
    <div class="kpis">${kpis}</div>
    <div class="grid-2">
      <div class="card card-pad">${cardHead('Session ต่อชั่วโมง', 'เฉลี่ยต่อวัน · shopping_sessions', badge('primary', 'ชั่วโมงเร่งด่วน 18–20 น.'))}
        ${lineChart({ vals, min: 0, max: 80, yl: ['80', '60', '40', '20', '0'], xl: ['08', '10', '12', '14', '16', '18', '20', '22'], peak: 11, peakLabel: `19:00 · ${vals[11]} session`, label: 'จำนวน session ต่อชั่วโมง' })}</div>
      <div class="card card-pad">${cardHead('อัตราเปลี่ยนใจต่อสินค้า', 'REMOVE ÷ ADD · v_product_abandon')}
        <div class="col gap-12">${ab.map(([k, rate, cnt]) => `<div class="col gap-4"><div class="row"><img class="mini-thumb" style="width:24px;height:24px;border-radius:4px" src="${PRODUCTS[k].img}" alt=""><span class="t-cap grow">${PRODUCTS[k].name}</span><span class="t-cap muted">${cnt}</span><span class="t-cap-strong">${Math.round(rate * 100)}%</span></div>
          <div class="bar-track"><span style="width:${rate / .35 * 100}%;background:${rate >= .2 ? 'var(--danger)' : 'var(--primary)'}"></span></div></div>`).join('')}</div></div>
    </div>
    <div class="grid-2">
      <div class="card card-pad">${cardHead('สินค้าที่ซื้อคู่กัน', 'v_cooccurrence · support และ lift (lift ≥ 2 = ซื้อคู่กันบ่อยผิดปกติ)')}
        <div class="table-wrap"><table class="table"><thead><tr><th>สินค้า A</th><th>สินค้า B</th><th class="r">Session ร่วม</th><th class="r">Support</th><th class="r">Lift</th></tr></thead><tbody>
        ${co.map(([a, b, s, sp, l]) => `<tr><td>${PRODUCTS[a].name}</td><td>${PRODUCTS[b].name}</td><td class="r num">${Math.round(s * r.f)}</td><td class="r num">${sp.toFixed(2)}</td><td class="r">${badge(l >= 2 ? 'success' : 'primary', l.toFixed(2))}</td></tr>`).join('')}
        </tbody></table></div></div>
      <div class="card card-pad">${cardHead('Alerts ล่าสุด', 'ตาราง alerts', `<a class="btn btn-ghost btn-m" href="#/a/live">ดู Live</a>`)}
        <div class="col gap-8">${ALERTS.map(([t, tone, msg, tm]) => `<div class="row">${badge(tone, t)}<span class="t-cap grow">${esc(msg)}</span><span class="t-cap muted">${tm}</span></div>`).join('')}</div></div>
    </div>`);
}

// ---------- camera view ----------
function camera(c, { aspect, uw = .8, small = false, cls = '' }) {
  const bs = c.boxes.length ? c.boxes : [[.3, .3, .7, .7]];
  const cx = (Math.min(...bs.map(b => b[0])) + Math.max(...bs.map(b => b[2]))) / 2;
  const cy = (Math.min(...bs.map(b => b[1])) + Math.max(...bs.map(b => b[3]))) / 2;
  const vh = Math.min(1, uw * 4 / (3 * aspect));
  const u0 = clamp(cx - uw / 2, 0, 1 - uw), v0 = clamp(cy - vh / 2, 0, 1 - vh);
  const stage = `left:${-u0 / uw * 100}%;top:${-v0 / vh * 100}%;width:${100 / uw}%;height:${100 / vh}%`;
  const det = (b, outside) => `<div class="det c-${outside ? 'd' : b[6]} ${outside ? 'outside' : ''}" style="left:${b[0] * 100}%;top:${b[1] * 100}%;width:${(b[2] - b[0]) * 100}%;height:${(b[3] - b[1]) * 100}%"><span>${b[4]} ${b[5].toFixed(2)}${outside ? ' · นอก ROI' : ''}</span></div>`;
  const dets = c.offline ? '' : c.boxes.map(b => det(b, false)).join('') + (c.outside || []).map(b => det(b, true)).join('');
  const roi = `<svg class="roi" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon points="20,14 80,14 96,99 4,99" fill="none" stroke="#F59E0B" stroke-width="2" stroke-dasharray="8 6" vector-effect="non-scaling-stroke"/></svg>`;
  const off = c.offline ? `<div class="cam-off">${ic('wifioff', 28)}<span>ไม่มีสัญญาณ · ภาพล่าสุด 14:40:21</span></div>` : '';
  const tag = `<div class="cam-tag"><span class="live" ${c.offline ? 'style="background:#64748B;animation:none"' : ''}></span>${c.offline ? 'OFFLINE' : 'LIVE'} · ${c.id}</div>`;
  return `<div class="cam ${small ? 'cam-sm' : ''} ${cls}" style="aspect-ratio:${aspect}">
    <div class="cam-stage" style="${stage}"><img src="assets/camera/${c.img}.jpg" alt="ภาพจากกล้องรถเข็น ${c.id}">${c.offline ? '' : roi}${dets}</div>${off}${tag}</div>`;
}
const cartTot = c => c.items.reduce((s, [k, q]) => s + PRODUCTS[k].price * q, 0);

function viewLive() {
  const f = state.liveFilter;
  const list = CARTS.filter(c => f === 0 || f === 'all' || (f === 1 && c.alert) || (f === 2 && c.status === 'disconnected'));
  const cards = list.map(c => {
    const items = c.items.slice(0, 2).map(([k, q]) => `<div class="row"><img src="${PRODUCTS[k].img}" alt="" style="width:20px;height:20px;border-radius:4px;object-fit:cover"><span class="t-cap grow">${PRODUCTS[k].name} ×${q}</span><span class="t-cap muted num">${baht(PRODUCTS[k].price * q)}</span></div>`).join('');
    const more = c.items.length > 2 ? `<span class="t-cap-strong" style="color:var(--primary)">+${c.items.length - 2} รายการ</span>` : '';
    const latTone = c.lat == null ? 'neutral' : c.lat > 300 ? 'warning' : 'neutral';
    return `<a class="card cart-card ${c.alert ? c.alert[0] : ''}" href="#/a/live/${c.id}" aria-label="เปิดรถเข็น ${c.id}">
      ${camera(c, { aspect: 2.4, small: true, cls: 'hide-outside' })}
      <div class="col gap-8" style="padding:12px 16px">
        <div class="row"><span class="t-strong grow">รถเข็น ${c.id}</span>${pill(c.status)}</div>
        <div class="col gap-4">${items}${more}</div>
        <div class="row"><span class="t-h3 grow num">${baht(cartTot(c))}</span>${badge(latTone, c.lat == null ? '— ms' : `p95 ${c.lat} ms`)}<span class="t-cap muted" data-upd="${c.id}">อัปเดต ${c.updated} วิ</span></div>
      </div>
      ${c.alert ? `<div class="alert-bar ${c.alert[0]}">${ic('alert', 16)}<span>${c.alert[1]}</span></div>` : ''}</a>`;
  }).join('');
  const sel = f === 'all' ? 0 : f;
  return aShell('live', `
    ${pageTitle('Live รถเข็น', 'Active 6 คัน · ภาพจากกล้องบนรถเข็น · /ws/admin ทุก ~250 ms', seg('live-filter', ['ทั้งหมด (6)', 'มี alert (3)', 'ขาดการเชื่อมต่อ (1)'], sel))}
    <div class="cart-grid">${cards || '<p class="muted">ไม่มีรถเข็นในกลุ่มนี้</p>'}</div>`);
}

function viewLiveDetail(id) {
  const c = CARTS.find(x => x.id === id);
  if (!c) return aShell('live', `<p>ไม่พบรถเข็น ${esc(id)} · <a href="#/a/live" style="color:var(--primary)">กลับไปหน้า Live</a></p>`);
  const t = state.toggles;
  const camCls = [t.boxes ? '' : 'hide-boxes', t.roi ? '' : 'hide-roi', t.outside ? '' : 'hide-outside'].join(' ');
  const toggle = (k, l) => `<button class="toggle ${t[k] ? 'on' : ''}" data-act="toggle" data-k="${k}" aria-pressed="${t[k]}"><span class="sw"><i></i></span>${l}</button>`;
  const allDet = c.boxes.map(b => [b, true]).concat((c.outside || []).map(b => [b, false]));
  const dets = c.offline ? '<span class="muted">ไม่มีเฟรมใหม่ใน 45 วินาที</span>' : allDet.map(([b, inRoi]) => `<div class="row">
      <img class="mini-thumb" style="width:32px;height:32px;border-radius:6px" src="${PRODUCTS[b[4]].img}" alt="">
      <span class="t-cap grow trunc" title="${b[4]}">${b[4]}</span>
      <span class="bar-track" style="width:56px;height:6px;flex:none"><span style="width:${b[5] * 100}%;background:${b[5] >= .7 ? 'var(--success)' : 'var(--warning)'}"></span></span>
      <span class="t-cap-strong num">${b[5].toFixed(2)}</span>${badge(inRoi ? 'success' : 'danger', inRoi ? 'ROI' : 'นอก ROI')}</div>`).join('');
  const evs = c.events || c.items.map(([k, q], i) => [`${c.started}:${String(10 + i * 17).padStart(2, '0')}`, 'ADD', k, '+' + q]);
  const total = cartTot(c);
  return aShell('live', `
    <div class="page-title"><a class="btn btn-ghost btn-m" href="#/a/live">${ic('back', 16)}Live</a>
      <div class="grow col"><h1 class="t-h1">รถเข็น ${c.id}</h1><span class="muted">session ${c.session} · เริ่ม ${c.started} · ${state.activeModel} · conf ≥ 0.70</span></div>
      ${pill(c.status)}${badge('neutral', '4.0 fps · 640×480')}</div>
    <div class="grid-detail">
      <div class="card col gap-12" style="padding:16px">
        ${camera(c, { aspect: 1.82, uw: c.id === 'A-08' ? .62 : .8, cls: camCls })}
        <div class="row wrap gap-12">${toggle('boxes', 'แสดงกรอบ (bounding box)')}${toggle('roi', 'แสดง ROI ตะกร้า')}${toggle('outside', 'แสดงนอก ROI')}
          <span class="spacer"></span><span class="t-cap muted">เส้นประเหลือง = ROI · กรอบแดง = นอก ROI (ไม่นับ)</span></div>
      </div>
      <div class="col gap-16">
        <div class="card card-pad">${cardHead('Detections (เฟรมนี้)', `${allDet.length} กล่อง · ${c.boxes.length} ใน ROI · conf ≥ 0.70`)}<div class="col gap-10" style="gap:10px">${dets}</div></div>
        <div class="card card-pad">${cardHead('รายการ (stable)', 'tracker W=8, K=3' + (c.status === 'updating' ? ' · มีรายการรอยืนยัน' : ''))}
          <div class="col gap-8">${c.items.map(([k, q]) => `<div class="row"><span class="t-cap grow">${PRODUCTS[k].name} ×${q}</span><span class="t-cap-strong num">${baht(PRODUCTS[k].price * q)}</span></div>`).join('')}
          <div class="row" style="margin-top:4px"><span class="t-strong muted grow">ราคารวม</span><span class="t-h2 num">${baht(total)}</span></div></div></div>
      </div>
    </div>
    <div class="card card-pad">${cardHead('Timeline ADD / REMOVE', 'cart_events · ภาพหลักฐาน ณ เหตุการณ์ (frames.image_path)')}
      <div class="row wrap gap-8">${evs.map(([tm, ty, k, d]) => `<span class="chip"><img src="${PRODUCTS[k].img}" alt="">${badge(ty === 'ADD' ? 'success' : 'danger', ty)}<span class="t-cap">${k} ${d}</span><span class="t-cap muted">${tm}</span></span>`).join('')}</div></div>`);
}

// ---------- models ----------
function deltaBadge(a, b, unit, lowerBetter, digits = 2) {
  if (a == null || b == null || Number.isNaN(a) || Number.isNaN(b)) return badge('neutral', '—');
  const d = b - a; if (Math.abs(d) < 1e-9) return badge('neutral', '±0');
  const good = lowerBetter ? d < 0 : d > 0;
  return badge(good ? 'success' : 'warning', `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(digits)}${unit}`);
}
function viewModels() {
  const staff = isStaff(), act = MODELS.find(m => m.name === state.activeModel);
  const prev = state.history[0] && state.history[0].from;
  const rollback = staff ? lockedBtn('secondary', 'm', 'ย้อนกลับรุ่นก่อนหน้า', 'ย้อนกลับโมเดลได้เฉพาะ admin', 'rollback')
    : btn('secondary', 'm', 'ย้อนกลับรุ่นก่อนหน้า', `data-act="model-pick" data-name="${prev}" data-rollback="1"`, 'rollback');
  const rows = MODELS.map(m => {
    const on = m.name === state.activeModel;
    const action = on ? `<span class="t-cap-strong" style="color:var(--success-text)">ใช้งานอยู่</span>`
      : staff ? lockedBtn('secondary', 'm', 'ใช้โมเดลนี้', 'เฉพาะผู้ดูแลระบบ (admin) เท่านั้นที่เปลี่ยนโมเดลได้')
        : btn('secondary', 'm', 'ใช้โมเดลนี้', `data-act="model-pick" data-name="${m.name}"`);
    return `<tr class="${on ? 'sel' : ''}"><td class="${on ? 't-strong' : ''}">${m.name}</td><td>${m.family}</td><td>${m.size}</td><td>${m.format}</td>
      <td class="r num">${m.map.toFixed(3)}</td><td class="r num">${m.p95.toFixed(2)} ms</td><td>${badge(on ? 'success' : 'neutral', on ? 'Active' : 'Standby')}</td><td class="r">${action}</td></tr>`;
  }).join('');
  const hist = state.history.map(h => `<div class="col gap-4" style="padding:8px 0;border-bottom:1px solid var(--border)"><div class="row"><span class="t-strong grow">${h.from.split('-')[0]} → ${h.to.split('-')[0]}</span>${badge(h.tone, h.result)}</div><span class="t-cap muted">${h.at} · ${h.by}</span></div>`).join('');
  return aShell('models', `
    ${pageTitle('โมเดล', staff ? 'มุมมอง staff · ดูได้อย่างเดียว การเปลี่ยนโมเดลสงวนสิทธิ์ให้ admin' : 'model_versions · benchmark บน test set 139 ภาพ · latency p95 จาก RTX 5090 (batch 1, imgsz 640)', badge(staff ? 'neutral' : 'primary', staff ? 'อ่านอย่างเดียว' : 'Admin'))}
    <div class="grid-side">
      <div class="col gap-16">
        <div class="card row gap-16" style="padding:16px 20px">
          <div class="icon-tile" style="background:var(--success-subtle);color:var(--success-text)">${ic('model', 24)}</div>
          <div class="grow col"><div class="row"><span class="t-h3">${act.name}</span>${badge('success', 'Active')}</div>
            <span class="t-cap muted">${act.family} · ${act.size} · ${act.format} · conf 0.70 · ${act.params} params${act.gflops ? ` · ${act.gflops} GFLOPs` : ''}</span></div>
          <div class="col" style="align-items:flex-end"><span class="t-h3 num">${act.map.toFixed(3)}</span><span class="t-cap muted">mAP50-95</span></div>
          <div class="col" style="align-items:flex-end"><span class="t-h3 num">${act.p95.toFixed(2)} ms</span><span class="t-cap muted">p95</span></div>
          ${rollback}
        </div>
        <div class="card card-pad">${cardHead('model_versions', '10 รุ่น · เรียงตาม mAP50-95')}
          <div class="table-wrap"><table class="table"><thead><tr><th>ชื่อ</th><th>ตระกูล</th><th>ขนาด</th><th>Format</th><th class="r">mAP50-95</th><th class="r">Latency p95</th><th>สถานะ</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>
      </div>
      <div class="col gap-16">
        <div class="card" style="padding:16px">${cardHead('mAP50-95 vs Latency p95', 'เส้นประเขียว = Pareto front')}${scatterChart(MODELS, state.activeModel)}
          <span class="t-cap muted">YOLOv4 (0.280, 6.44 ms) อยู่นอกกรอบกราฟ</span></div>
        <div class="card" style="padding:16px">${cardHead('ประวัติการสลับโมเดล', '')}${hist}</div>
      </div>
    </div>
    ${state.modelModal ? modelModal() : ''}${state.modelProgress ? progressModal() : ''}`);
}
function modelModal() {
  const cur = MODELS.find(m => m.name === state.activeModel), nx = MODELS.find(m => m.name === state.modelModal.name);
  const rows = [
    ['mAP50-95', cur.map.toFixed(3), nx.map.toFixed(3), deltaBadge(cur.map, nx.map, '', false, 3)],
    ['Latency p95', cur.p95.toFixed(2) + ' ms', nx.p95.toFixed(2) + ' ms', deltaBadge(cur.p95, nx.p95, ' ms', true)],
    ['Params', cur.params, nx.params, deltaBadge(parseFloat(cur.params), parseFloat(nx.params), 'M', true)],
    ['GFLOPs', cur.gflops ?? '—', nx.gflops ?? '—', deltaBadge(cur.gflops, nx.gflops, '', true, 1)],
    ['Format', cur.format, nx.format, badge('neutral', cur.format === nx.format ? 'เท่าเดิม' : 'เปลี่ยน')],
  ];
  return `<div class="backdrop" data-act="modal-close-bg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mm-title">
    <div class="row"><span id="mm-title" class="t-h2 grow">${state.modelModal.rollback ? 'ยืนยันย้อนกลับโมเดล' : 'ยืนยันเปลี่ยนโมเดล'}</span><button class="icon-btn bare" data-act="modal-close" aria-label="ปิด">${ic('close')}</button></div>
    <span class="muted">สลับจาก ${cur.name} → ${nx.name} สำหรับรถเข็นทุกคันในสาขาลาดพร้าว (active 6 คัน)</span>
    <table class="table"><thead><tr><th>ค่า</th><th class="r">ปัจจุบัน · ${cur.name.split('-')[0]}</th><th class="r">ใหม่ · ${nx.name.split('-')[0]}</th><th class="r">ส่วนต่าง</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${r[0]}</td><td class="r num">${r[1]}</td><td class="r num">${r[2]}</td><td class="r">${r[3]}</td></tr>`).join('')}</tbody></table>
    <div class="banner warn" style="margin:0">${ic('info', 20)}<span class="t-cap">ระหว่างสลับ (~20 วินาที) ระบบใช้โมเดลเดิมจน warm-up 50 เฟรมเสร็จ และย้อนกลับได้ทันทีจากหน้านี้</span></div>
    <div class="row" style="justify-content:flex-end">${btn('secondary', 'm', 'ยกเลิก', 'data-act="modal-close"')}${btn('primary', 'm', state.modelModal.rollback ? 'ยืนยันย้อนกลับ' : 'ยืนยันเปลี่ยนโมเดล', 'data-act="model-confirm"')}</div>
  </div></div>`;
}
const STEPS = ['โหลด weights', 'ตรวจ checksum และ class map 11 คลาส', 'Warm-up 50 เฟรม', 'สลับ traffic ทุกรถเข็น', 'ตรวจ latency p95 ≤ 300 ms'];
function progressModal() {
  const p = state.modelProgress, step = Math.min(4, Math.floor(p.pct / 20));
  return `<div class="backdrop"><div class="modal sm" role="dialog" aria-modal="true" aria-labelledby="pg-title">
    <span id="pg-title" class="t-h2">กำลังสลับโมเดล…</span>
    <span class="muted">${state.activeModel.split('-')[0]} → ${p.name.split('-')[0]} · รถเข็นยังทำงานด้วยโมเดลเดิมระหว่างนี้</span>
    <div class="col gap-8"><div class="row"><span class="t-label grow">ขั้นที่ ${step + 1} จาก 5 · ${STEPS[step]}</span><span class="t-strong num" style="color:var(--primary)">${Math.round(p.pct)}%</span></div>
      <div class="bar-track" role="progressbar" aria-valuenow="${Math.round(p.pct)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${p.pct}%;transition:width .2s"></span></div></div>
    <div class="steps">${STEPS.map((s, i) => {
      const st = i < step ? 'done' : i === step ? 'run' : 'todo';
      const note = i === 2 && st === 'run' ? `${Math.round(((p.pct - 40) / 20) * 50)}/50` : st === 'done' ? 'เสร็จ' : '';
      return `<div class="step ${st}"><span class="st">${st === 'done' ? ic('check', 14) : st === 'run' ? '<i></i>' : ''}</span><span class="grow ${st === 'todo' ? '' : 't-strong'}">${s}</span><span class="t-cap muted">${note}</span></div>`;
    }).join('')}</div>
    <div class="row" style="justify-content:flex-end">${btn('ghost', 'm', 'ยกเลิกการสลับ', 'data-act="model-cancel"')}</div>
  </div></div>`;
}
let progressTimer = null;
function startSwitch() {
  const { name, rollback } = state.modelModal;
  state.modelModal = null; state.modelProgress = { name, pct: 0 }; render();
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    const p = state.modelProgress; if (!p) { clearInterval(progressTimer); return; }
    p.pct = Math.min(100, p.pct + 4);
    if (p.pct >= 100) {
      clearInterval(progressTimer);
      const from = state.activeModel; state.activeModel = name; state.modelProgress = null;
      state.history.unshift({ at: 'วันนี้ ' + nowTime().slice(0, 5), from, to: name, by: `${state.user.name.split(' ')[0]} (admin)`, result: rollback ? 'ย้อนกลับ · สำเร็จ' : 'สำเร็จ · 5 วิ', tone: rollback ? 'warning' : 'success' });
      toast('success', `สลับเป็น ${name.split('-')[0]} สำเร็จ · p95 ${MODELS.find(m => m.name === name).p95.toFixed(2)} ms`);
    }
    if (location.hash === '#/a/models') render();
  }, 200);
}

// ---------- sessions ----------
const ST_TONE = { active: 'primary', checked_out: 'success', abandoned: 'neutral', timeout: 'warning' };
function sessionEvents(row) {
  const [id, cart, start, , n] = row;
  if (SESSION_EVENTS[id]) return SESSION_EVENTS[id];
  const c = CARTS.find(x => x.id === cart);
  const keys = c ? c.items.map(i => i[0]) : Object.keys(PRODUCTS);
  const evs = [[`${start}:05`, 'START', null, `เริ่ม session · สแกน QR รถเข็น ${cart}`, 'source: customer']];
  for (let i = 0; i < Math.min(n, 6); i++) { const k = keys[i % keys.length]; evs.push([`${start.slice(0, 3)}${String(+start.slice(3) + i + 1).padStart(2, '0')}:${String(12 + i * 7).padStart(2, '0')}`, 'ADD', k, `${PRODUCTS[k].name} +1`, `conf 0.${90 + (i % 7)} · auto`]); }
  if (row[7] === 'checked_out') evs.push([row[3], 'CHECKOUT', null, `ชำระเงิน · POS ${baht(row[6])}`, row[6] !== row[5] ? `ยอดระบบ ${baht(row[5])} ไม่ตรง POS` : 'ยอดตรงกับระบบ']);
  if (n === 0) evs.push(['—', 'ABANDONED', null, 'ไม่มีการหยิบสินค้า · session หมดอายุ', 'status = abandoned']);
  return evs;
}
function viewSessions() {
  const rows = SESSIONS.map(r => {
    const [id, cart, st, du, n, auto, pos, s] = r;
    return `<tr class="click ${id === state.selSession ? 'sel' : ''}" data-act="sel-session" data-id="${id}" tabindex="0"><td class="t-strong">${id}</td><td>${cart}</td><td>${st}</td><td>${du}</td><td class="r num">${n}</td><td class="r num">${baht(auto)}</td>
      <td class="r num" style="color:${pos != null && pos !== auto ? 'var(--danger)' : 'inherit'}">${pos == null ? '—' : baht(pos)}</td><td>${badge(ST_TONE[s], s)}</td></tr>`;
  }).join('');
  const row = SESSIONS.find(r => r[0] === state.selSession), evs = sessionEvents(row);
  const tone = t => ({ ADD: 'success', REMOVE: 'danger', CORRECTION: 'warning', CHECKOUT: 'primary' }[t] || 'neutral');
  const dotc = t => ({ ADD: 'var(--success)', REMOVE: 'var(--danger)', CORRECTION: 'var(--warning)', CHECKOUT: 'var(--primary)' }[t] || 'var(--text-2)');
  const tl = evs.map(([tm, ty, k, txt, meta], i) => `<div class="tl-row"><span class="t-cap-strong muted" style="padding-top:4px">${tm}</span>
    <div class="tl-rail"><span class="dot" style="background:${dotc(ty)}"></span>${i < evs.length - 1 ? '<span class="line"></span>' : ''}</div>
    <div class="tl-body"><div class="grow col gap-4"><div class="row">${badge(tone(ty), ty)}<span class="t-strong">${esc(txt)}</span></div><span class="t-cap muted">${esc(meta)}</span></div>${k ? `<img src="${PRODUCTS[k].img}" alt="ภาพ ณ เหตุการณ์">` : ''}</div></div>`).join('');
  const counts = t => evs.filter(e => e[1] === t).length;
  return aShell('sessions', `
    ${pageTitle('Sessions', 'shopping_sessions · วันนี้ 46 session · เลือกแถวเพื่อดู timeline')}
    <div class="grid-2" style="grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);align-items:start">
      <div class="card card-pad">${cardHead('รายการ session', 'ยอดระบบ (total_auto) เทียบยอดจริงจาก POS (total_checkout) · ตัวแดง = ไม่ตรง')}
        <div class="table-wrap"><table class="table"><thead><tr><th>Session</th><th>รถเข็น</th><th>เริ่ม</th><th>ระยะเวลา</th><th class="r">ชิ้น</th><th class="r">ยอดระบบ</th><th class="r">ยอด POS</th><th>สถานะ</th></tr></thead><tbody>${rows}</tbody></table></div></div>
      <div class="card card-pad">${cardHead(`Timeline · ${row[0]}`, `รถเข็น ${row[1]} · เริ่ม ${row[2]} · cart_events + frames.image_path`, badge(ST_TONE[row[7]], row[7]))}
        <div class="row gap-8" style="margin-bottom:16px">${[['ADD', counts('ADD')], ['REMOVE', counts('REMOVE')], ['CORRECTION', counts('CORRECTION')], ['ยอด', baht(row[5])]].map(([l, v]) => `<div class="col grow" style="padding:8px 12px;border-radius:8px;background:var(--bg)"><span class="t-strong num">${v}</span><span class="t-cap muted">${l}</span></div>`).join('')}</div>
        ${tl}</div>
    </div>`);
}

// ---------- products ----------
function viewProducts() {
  const staff = isStaff(), k = state.editProduct, p = PRODUCTS[k];
  const hist = state.priceHist[k] || [[baht(p.price), '1 ต.ค. 2026 – ปัจจุบัน', true]];
  const rows = Object.entries(PRODUCTS).map(([key, x]) => `<tr class="${key === k ? 'sel' : ''}">
    <td class="wrap"><div class="row gap-12"><img class="mini-thumb" src="${x.img}" alt=""><div class="col"><span class="t-strong">${esc(x.name)}</span><span class="t-cap muted">${key}</span></div></div></td>
    <td>${x.sku}</td><td class="r num">${baht(x.price)}</td><td class="r num">${x.promo ? baht(x.promo) : '—'}</td><td>${x.updated || '1 ต.ค. 2026'}</td><td>${badge('success', 'ขายอยู่')}</td>
    <td class="r">${staff ? lockedBtn('ghost', 'm', 'แก้ไข', 'เฉพาะ admin เท่านั้น', 'edit') : btn('ghost', 'm', 'แก้ไข', `data-act="edit-product" data-k="${key}"`, 'edit')}</td></tr>`).join('');
  const dis = staff ? 'is-disabled' : '';
  const ro = staff ? 'disabled' : '';
  return aShell('products', `
    ${pageTitle('สินค้าและราคา', staff ? 'มุมมอง staff · ดูราคาได้ แต่แก้ไขราคาได้เฉพาะ admin' : 'products + product_prices (เก็บประวัติราคา SCD2) · 11 สินค้าตามคลาสของโมเดล',
      staff ? lockedBtn('primary', 'm', 'เพิ่มสินค้า', 'เพิ่มสินค้าได้เฉพาะ admin', 'plus') : btn('primary', 'm', 'เพิ่มสินค้า', 'data-act="add-product"', 'plus'))}
    <div class="grid-side-320">
      <div class="card card-pad">${cardHead('สินค้าทั้งหมด (11)', 'class_name ต้องตรงกับ label ของโมเดล')}
        <div class="table-wrap"><table class="table"><thead><tr><th>สินค้า</th><th>SKU</th><th class="r">ราคา</th><th class="r">โปรโมชั่น</th><th>อัปเดต</th><th>สถานะ</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>
      <div class="card card-pad col gap-16" style="position:sticky;top:96px">
        <div class="row gap-12"><img class="mini-thumb" style="width:56px;height:56px" src="${p.img}" alt=""><div class="col"><span class="t-h3">${staff ? 'ราคา · ดูอย่างเดียว' : 'แก้ไขราคา'}</span><span class="t-cap muted">${esc(p.name)} · ${k}</span></div></div>
        <div class="field"><label for="price">ราคาปกติ (บาท)</label><div class="input ${dis}">${ic('product')}<input id="price" type="number" min="0" step="0.5" value="${p.price.toFixed(2)}" ${ro}></div></div>
        <div class="field"><label for="promo">ราคาโปรโมชั่น (promo_price)</label><div class="input ${dis}">${ic('product')}<input id="promo" type="number" min="0" step="0.5" value="${p.promo ? p.promo.toFixed(2) : ''}" placeholder="ไม่มี" ${ro}></div><span class="helper">เว้นว่างถ้าไม่มีโปรโมชั่น</span></div>
        <div class="field"><label for="from">มีผลตั้งแต่ (valid_from)</label><div class="input ${dis}">${ic('calendar')}<input id="from" type="text" value="1 พ.ย. 2026 00:00" ${ro}></div></div>
        <div class="col gap-8"><span class="t-strong">ประวัติราคา (product_prices)</span>
          ${hist.map(([pr, rg, cur]) => `<div class="row" style="padding:8px 12px;border-radius:8px;background:var(--bg)"><span class="t-strong num">${pr}</span><span class="t-cap muted grow">${rg}</span>${cur ? badge('success', 'ปัจจุบัน') : ''}</div>`).join('')}</div>
        <div class="row gap-12">${btn('secondary', 'm', 'ยกเลิก', 'data-act="edit-reset" style="flex:1"')}${staff ? `<span style="flex:1;display:flex" class="tip" data-tip="แก้ราคาได้เฉพาะผู้ดูแลระบบ (admin)" tabindex="0"><button class="btn btn-primary btn-m" style="flex:1" disabled>บันทึกราคา</button></span>` : btn('primary', 'm', 'บันทึกราคา', 'data-act="save-price" style="flex:1"')}</div>
      </div>
    </div>`);
}

// ---------- latency ----------
function viewLatency() {
  const f = [0.92, 1, 1.07][state.latWin];
  const e2e = [Math.round(142 * f), Math.round(268 * f), Math.round(412 * f)];
  const vals = [214, 206, 198, 201, 205, 212, 224, 236, 248, 252, 247, 255, 262, 258, 251, 260, 279, 296, 342, 301, 276, 254, 231, 219].map(v => Math.round(v * f));
  const kpi = (l, v, b, tone, note) => `<div class="card kpi"><div class="row"><span class="t-label muted grow">${l}</span><span class="tile">${ic('latency', 18)}</span></div><span class="t-h1 num">${v}</span><div class="row">${badge(tone, b)}<span class="t-cap muted">${note}</span></div></div>`;
  const rows = LATENCY.map(([l, a, b, c], i) => `<tr><td>${l}</td><td class="r num">${Math.round(a * f)}</td><td class="r num t-strong">${Math.round(b * f)}</td><td class="r num">${Math.round(c * f)}</td>
    <td><div class="bar-track" style="width:120px"><span style="width:${Math.max(2, b / 268 * 100)}%;background:${i === 4 ? 'var(--primary)' : 'var(--success)'}"></span></div></td></tr>`).join('')
    + `<tr><td class="t-strong">End-to-end</td><td class="r num t-strong">${e2e[0]}</td><td class="r num t-strong" style="color:${e2e[1] > 300 ? 'var(--danger)' : 'inherit'}">${e2e[1]}</td><td class="r num t-strong">${e2e[2]}</td><td><div class="bar-track" style="width:120px"><span style="width:100%;background:var(--text)"></span></div></td></tr>`;
  const seg5 = [['Network', 118, 'var(--primary)'], ['Inference', 9, 'var(--success)'], ['Queue', 4, 'var(--warning)'], ['DB', 3, 'var(--danger)'], ['Tracker', 1, 'var(--text-2)'], ['อื่น ๆ', 7, 'var(--border)']];
  return aShell('latency', `
    ${pageTitle('Latency monitor', 'v_frame_latency · /api/admin/latency · 6 รถเข็น · 4 fps', seg('lat-win', ['1 ชม.', '24 ชม.', '7 วัน'], state.latWin) + badge('primary', 'เกณฑ์ p95 ≤ 300 ms'))}
    <div class="kpis">
      ${kpi('End-to-end p50', e2e[0] + ' ms', '−6 ms', 'success', 'เทียบช่วงก่อนหน้า')}
      ${kpi('End-to-end p95', e2e[1] + ' ms', e2e[1] <= 300 ? 'ผ่านเกณฑ์' : 'เกินเกณฑ์', e2e[1] <= 300 ? 'success' : 'danger', 'เกณฑ์ 300 ms')}
      ${kpi('End-to-end p99', e2e[2] + ' ms', '+18 ms', 'warning', 'ช่วงเร่งด่วน')}
      ${kpi('เฟรมที่ถูกทิ้ง', '1.8%', 'คิว > 2 เฟรม', 'neutral', 'dropped = 1')}
    </div>
    <div class="grid-2" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
      <div class="card card-pad">${cardHead('End-to-end p95 ตามเวลา', ['1 ชม. · ต่อ 2.5 นาที', '24 ชม. · ต่อ 1 ชม.', '7 วัน · ต่อ 7 ชม.'][state.latWin], badge(Math.max(...vals) > 300 ? 'warning' : 'success', Math.max(...vals) > 300 ? '18:00 เกินเกณฑ์' : 'ไม่เกินเกณฑ์'))}
        ${lineChart({ vals, min: 100, max: 400, yl: ['400', '300', '200', '100'], xl: ['00', '04', '08', '12', '16', '20', '24'], peak: 18, peakLabel: `18:00 · p95 ${vals[18]} ms`, threshold: 300, thLabel: 'เกณฑ์ 300 ms', label: 'latency p95 ตามเวลา' })}</div>
      <div class="card card-pad">${cardHead('แยกตามช่วง (ms)', 'queue → infer → tracker → db → push · network = RTT จาก device')}
        <div class="table-wrap"><table class="table"><thead><tr><th>ช่วง</th><th class="r">p50</th><th class="r">p95</th><th class="r">p99</th><th>สัดส่วน p95</th></tr></thead><tbody>${rows}</tbody></table></div></div>
    </div>
    <div class="card card-pad">${cardHead(`องค์ประกอบ latency p50 (${e2e[0]} ms)`, 'Network RTT คิดเป็น 83% → ลดขนาด JPEG หรือย้าย server ใกล้สาขา')}
      <div style="display:flex;gap:2px;height:16px;border-radius:4px;overflow:hidden">${seg5.map(([l, v, c]) => `<span title="${l} ${v} ms" style="flex:${v};background:${c}"></span>`).join('')}</div>
      <div class="row wrap gap-16" style="margin-top:12px">${seg5.map(([l, v, c]) => `<span class="row gap-4 t-cap"><span style="width:10px;height:10px;border-radius:3px;background:${c}"></span>${l} ${v} ms</span>`).join('')}</div></div>`);
}

// =====================================================================
// ROUTER + EVENTS
// =====================================================================
const VIEWS = {
  '/': viewRole, '/c/scan': viewScan, '/c/welcome': viewWelcome, '/c/gender': viewGender, '/c/age': viewAge,
  '/c/cart': viewCart, '/c/summary': viewSummary, '/c/error-qr': viewErrQr, '/c/error-busy': viewErrBusy,
  '/a/login': viewLogin, '/a/dashboard': viewDashboard, '/a/live': viewLive, '/a/models': viewModels,
  '/a/sessions': viewSessions, '/a/products': viewProducts, '/a/latency': viewLatency,
};
const currentPath = () => location.hash.replace(/^#/, '') || '/';
function render() {
  const p = currentPath();
  if (p.startsWith('/a/') && p !== '/a/login' && !state.user) { location.replace('#/a/login'); return; }
  const m = p.match(/^\/a\/live\/(.+)$/);
  $('#app').innerHTML = m ? viewLiveDetail(decodeURIComponent(m[1])) : (VIEWS[p] || viewRole)();
}
window.addEventListener('hashchange', () => { state.bell = false; render(); window.scrollTo(0, 0); });

const go = to => { location.hash = to; };
const ACT = {
  go: el => go(el.dataset.to),
  'scan-ok': () => { toast('success', 'สแกนสำเร็จ · รถเข็น A-07'); setTimeout(() => go('#/c/welcome'), 500); },
  pick: el => { state[el.dataset.key] = el.dataset.val; render(); },
  'sheet-open': () => { state.cart.sheet = true; render(); },
  'sheet-close': () => { state.cart.sheet = false; render(); },
  'sheet-close-bg': (el, e) => { if (e.target === el) { state.cart.sheet = false; render(); } },
  issue: el => { state.cart.issue = el.dataset.val; render(); },
  'sheet-submit': () => { state.cart.sheet = false; render(); toast('success', 'ส่งแจ้งปัญหาแล้ว ขอบคุณค่ะ · พนักงานจะตรวจสอบที่จุดชำระเงิน'); },
  checkout: () => { state.checkoutUntil = Date.now() + 600000; go('#/c/summary'); },
  'call-staff': () => toast('info', 'แจ้งพนักงานแล้ว กรุณารอสักครู่'),
  'sim-add': () => { if (currentPath() !== '/c/cart') go('#/c/cart'); simAdd(); },
  'sim-remove': () => { if (currentPath() !== '/c/cart') go('#/c/cart'); simRemove(); },
  'sim-net': () => {
    const c = state.cart; if (currentPath() !== '/c/cart') go('#/c/cart');
    if (c.status === 'disconnected') { c.status = 'updating'; render(); setTimeout(() => { c.status = 'connected'; c.lastSync = nowTime(); render(); toast('success', 'เชื่อมต่อใหม่แล้ว · ดึงสถานะล่าสุดจาก GET /api/sessions/{id}'); }, 1200); }
    else { c.lastSync = nowTime(); c.status = 'disconnected'; c.pending = false; render(); }
  },
  'sim-empty': () => { state.cart.items = []; state.cart.status = 'connected'; state.cart.pending = false; go('#/c/cart'); render(); },
  'sim-reset': () => { Object.assign(state.cart, { status: 'connected', pending: false, items: INITIAL_CART(), sheet: false }); go('#/c/cart'); render(); },
  fill: el => { const r = el.dataset.role; state.loginEmail = `${r}@smartcart.co.th`; state.loginPw = `${r}1234`; render(); },
  forgot: () => toast('info', 'ส่งลิงก์รีเซ็ตรหัสผ่านไปที่อีเมลแล้ว (จำลอง)'),
  logout: (el, e) => { e.preventDefault(); state.user = null; state.loginPw = ''; state.loginErr = false; go('#/a/login'); },
  bell: () => { state.bell = !state.bell; render(); },
  range: el => { state.range = +el.dataset.v; render(); },
  'live-filter': el => { state.liveFilter = +el.dataset.v; render(); },
  toggle: el => { const k = el.dataset.k; state.toggles[k] = !state.toggles[k]; render(); },
  'model-pick': el => { if (isStaff()) return; state.modelModal = { name: el.dataset.name, rollback: !!el.dataset.rollback }; render(); },
  'modal-close': () => { state.modelModal = null; render(); },
  'modal-close-bg': (el, e) => { if (e.target === el) { state.modelModal = null; render(); } },
  'model-confirm': () => startSwitch(),
  'model-cancel': () => { clearInterval(progressTimer); state.modelProgress = null; render(); toast('warning', `ยกเลิกการสลับแล้ว · ยังใช้ ${state.activeModel.split('-')[0]}`); },
  'sel-session': el => { state.selSession = el.dataset.id; render(); },
  'edit-product': el => { state.editProduct = el.dataset.k; render(); },
  'edit-reset': () => render(),
  'add-product': () => toast('info', 'ฟอร์มเพิ่มสินค้าจะทำในขั้นพัฒนาจริง (POST /api/admin/products)'),
  'save-price': () => {
    const k = state.editProduct, p = PRODUCTS[k];
    const price = parseFloat($('#price').value), promoRaw = $('#promo').value.trim(), promo = promoRaw ? parseFloat(promoRaw) : null;
    if (!(price > 0)) { toast('danger', 'ราคาต้องมากกว่า 0'); return; }
    if (promo != null && !(promo > 0 && promo < price)) { toast('danger', 'ราคาโปรโมชั่นต้องน้อยกว่าราคาปกติ'); return; }
    const hist = state.priceHist[k] || [[baht(p.price), '1 ต.ค. 2026 – ปัจจุบัน', true]];
    if (price !== p.price) { hist[0] = [hist[0][0], hist[0][1].replace('ปัจจุบัน', '31 ต.ค. 2026'), false]; hist.unshift([baht(price), `${$('#from').value} – ปัจจุบัน`, true]); }
    state.priceHist[k] = hist; p.price = price; p.promo = promo || undefined; p.updated = 'วันนี้ ' + nowTime().slice(0, 5);
    render(); toast('success', `บันทึกราคา ${p.name} แล้ว`);
  },
  'lat-win': el => { state.latWin = +el.dataset.v; render(); },
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  if (el.tagName === 'A' && el.dataset.act !== 'logout') return;
  if (el.dataset.act !== 'sheet-close-bg' && el.dataset.act !== 'modal-close-bg') e.preventDefault();
  ACT[el.dataset.act] && ACT[el.dataset.act](el, e);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (state.cart.sheet) { state.cart.sheet = false; render(); } else if (state.modelModal) { state.modelModal = null; render(); } else if (state.bell) { state.bell = false; render(); } }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-act]')) { e.preventDefault(); ACT[e.target.dataset.act](e.target, e); }
});
document.addEventListener('change', e => {
  const k = e.target.dataset.change; if (!k) return;
  if (k === 'pdpa') { state.pdpa = e.target.checked; const b = $('#start'); if (b) b.disabled = !state.pdpa; }
  if (k === 'issueProduct') state.cart.issueProduct = e.target.value;
});
document.addEventListener('input', e => { const k = e.target.dataset.input; if (k) state[k] = e.target.value; });
document.addEventListener('submit', e => {
  if (e.target.dataset.submit !== 'login') return;
  e.preventDefault();
  if (state.attempts <= 0) return;
  const acc = ACCOUNTS[state.loginEmail.trim().toLowerCase()];
  if (acc && acc.password === state.loginPw) {
    state.user = { ...acc, email: state.loginEmail }; state.loginErr = false; state.attempts = 3; state.loginPw = '';
    go('#/a/dashboard'); toast('success', `ยินดีต้อนรับ ${acc.name} (${acc.role})`);
  } else { state.attempts -= 1; state.loginErr = true; render(); }
});

// ตัวนับเวลา: countdown หน้าสรุปยอด + "อัปเดต X วิ" หน้า Live
setInterval(() => {
  const cd = document.querySelector('[data-countdown]');
  if (cd) cd.textContent = countdownText();
  document.querySelectorAll('[data-upd]').forEach(el => {
    const c = CARTS.find(x => x.id === el.dataset.upd);
    if (c.offline) c.updated += 1; else c.updated = c.updated >= 3 ? 1 : c.updated + 1;
    el.textContent = `อัปเดต ${c.updated} วิ`;
  });
}, 1000);

render();
