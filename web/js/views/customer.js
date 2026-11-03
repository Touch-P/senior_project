'use strict';
/* Customer screens with real data (C-01 … C-09). The cart listens to /ws/display/{session_id}; the session id
 * is kept in sessionStorage so a reload continues the same session. Mock mode keeps the prototype screens.
 */
const LiveCustomer = (() => {
  const PROTO_IMG = new Set(Object.keys(PRODUCTS));
  const GENDER = { 'ชาย': 'male', 'หญิง': 'female', 'อื่น ๆ': 'other', 'ไม่ระบุ': 'unspecified' };
  const AGE = { 'ต่ำกว่า 18': '<18', '18–24': '18-24', '25–34': '25-34', '35–44': '35-44', '45–54': '45-54', '55–64': '55-64', '65 ขึ้นไป': '65+', 'ไม่ระบุ': 'unspecified' };
  const C = state.c = {
    session: null, snap: null, status: 'updating', lastSync: '—', marks: new Map(), ghosts: [], summary: null,
    busyCart: null, manual: false, scan: null, demo: null, demoRunning: null, ws: null, retry: 0,
  };
  const key = 'sc-session';
  const store = { get() { try { return sessionStorage.getItem(key); } catch { return null; } }, set(v) { try { v ? sessionStorage.setItem(key, v) : sessionStorage.removeItem(key); } catch { /* private */ } } };
  const img = (cls, name, klass = 'thumb') => (PROTO_IMG.has(cls)
    ? `<img class="${klass}" src="assets/products/${esc(cls)}.jpg" alt="${esc(name)}">`
    : `<span class="${klass}" style="display:grid;place-items:center;background:var(--surface-muted);color:var(--text-2)">${ic('product', 20)}</span>`);
  const hhmm = (ms) => new Date(ms).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

  // ------------------------------------------------------------ session
  async function start(input) {
    try {
      const s = await API.post('/api/sessions', input);
      C.session = s; C.snap = null; C.summary = null; C.marks.clear(); C.ghosts = [];
      state.pdpa = false; state.gender = null; state.age = null;
      store.set(s.session_id);
      connect();
      go('#/c/welcome');
    } catch (err) {
      if (err.code === 'INVALID_QR') go('#/c/error-qr');
      else if (err.code === 'CART_IN_USE') { C.busyCart = err.body.cart ?? input.cart ?? '—'; go('#/c/error-busy'); }
      else toast('danger', err.message);
    }
  }

  async function restore() {
    const id = store.get();
    if (!id) return;
    try {
      const s = await API.get(`/api/sessions/${id}`);
      if (s.status !== 'active') { store.set(null); return; }
      C.session = { session_id: s.session_id, cart: s.cart, started_at_ms: s.started_at_ms, store: Live.meta?.store?.name_th };
      C.snap = s;
      state.pdpa = Boolean(s.pdpa_consent);
      connect();
    } catch { store.set(null); }
  }

  /** /ws/display: cart_update on every change; reconnect with backoff and refetch the session (brief 5/10). */
  function connect() {
    if (!C.session) return;
    C.ws?.close();
    const ws = C.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/display/${C.session.session_id}`);
    ws.onopen = () => { C.retry = 0; if (C.status === 'disconnected') toast('success', 'เชื่อมต่อใหม่แล้ว · ดึงสถานะล่าสุดจาก server'); C.status = 'connected'; refresh(); };
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'cart_update') apply(m); };
    ws.onclose = (e) => {
      if (C.ws !== ws) return;
      if (e.code === 4001 || C.snap?.status && C.snap.status !== 'active') return; // session closed
      C.status = 'disconnected';
      refresh();
      setTimeout(async () => {
        if (C.ws !== ws || !C.session) return;
        try { apply({ ...(await API.get(`/api/sessions/${C.session.session_id}`)), type: 'cart_update' }); } catch { /* still offline */ }
        connect();
      }, Math.min(10_000, 1000 * 2 ** C.retry++));
    };
  }

  /** New snapshot: mark added rows green for 2 s and show removed units struck through for 1.5 s (prototype). */
  function apply(snap) {
    const before = new Map((C.snap?.items ?? []).map((i) => [i.class_name, i]));
    for (const it of snap.items) {
      const prev = before.get(it.class_name);
      if (!prev || it.qty > prev.qty) mark(it.class_name, 'added', 2000);
      if (prev && it.qty < prev.qty) ghost({ ...prev, qty: prev.qty - it.qty });
      before.delete(it.class_name);
    }
    for (const gone of before.values()) ghost(gone);
    C.snap = snap;
    C.lastSync = new Date().toLocaleTimeString('en-GB');
    if (C.status !== 'disconnected') C.status = snap.state === 'updating' ? 'updating' : 'connected';
    if (snap.status && snap.status !== 'active') { store.set(null); C.status = 'connected'; }
    refresh();
  }
  function mark(cls, kind, ms) { C.marks.set(cls, kind); setTimeout(() => { if (C.marks.get(cls) === kind) { C.marks.delete(cls); refresh(); } }, ms); }
  function ghost(item) { const g = { ...item, ghost: true }; C.ghosts.push(g); setTimeout(() => { C.ghosts = C.ghosts.filter((x) => x !== g); refresh(); }, 1500); }
  const refresh = () => { if (currentPath().startsWith('/c/')) render(); };

  // ------------------------------------------------------------ views
  const items = () => (C.snap?.items ?? []);
  const count = () => C.snap?.item_count ?? 0;
  const total = () => C.snap?.total ?? 0;

  function row(it) {
    const st = it.ghost ? 'removed' : C.marks.get(it.class_name) ?? '';
    const note = st === 'added' ? '<span class="t-cap-strong" style="color:var(--success-text)">+1 เพิ่งเพิ่ม</span>'
      : st === 'removed' ? '<span class="t-cap-strong" style="color:var(--danger)">นำออกจากตะกร้าแล้ว</span>' : '';
    return `<div class="p-row ${st}">${img(it.class_name, it.name)}
      <div class="grow col"><span class="name t-strong">${esc(it.name)}</span><span class="t-cap muted">${baht(it.unit_price ?? 0)} / ชิ้น</span>${note}</div>
      <span class="t-label muted num">× ${it.qty}</span><span class="sub t-strong num">${baht((it.unit_price ?? 0) * it.qty)}</span></div>`;
  }

  function needSession() {
    return cShell('/c/cart', `<div class="c-body"><div class="empty" style="gap:16px"><div class="illus">${ic('qr', 44)}</div>
      <h1 class="t-h1">ยังไม่ได้เริ่มใช้รถเข็น</h1><p class="t-body-l muted" style="margin:0">สแกน QR บนด้ามจับรถเข็นเพื่อเริ่ม</p></div></div>
      <div class="c-bottom"><a class="btn btn-primary btn-l btn-block" href="#/c/scan">สแกน QR</a></div>`);
  }

  function viewScan() {
    const manual = C.manual ? `<div class="sheet-wrap" data-act="lc-manual-bg"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="m-title" style="color:var(--text)">
        <div class="grabber"></div><span id="m-title" class="t-h2">กรอกรหัสรถเข็น</span><span class="muted">ดูรหัสบนป้ายที่ด้ามจับ เช่น A-07</span>
        <div class="field"><label for="cart-code">รหัสรถเข็น</label><div class="input">${ic('cart')}<input id="cart-code" type="text" inputmode="text" autocomplete="off" placeholder="A-07" maxlength="4" style="text-transform:uppercase"></div></div>
        <div class="row gap-12">${btn('secondary', 'l', 'ยกเลิก', 'data-act="lc-manual-close" style="flex:1"')}${btn('primary', 'l', 'เริ่มใช้งาน', 'data-act="lc-manual-go" style="flex:1"')}</div></div></div>` : '';
    const cam = C.scan
      ? `<video id="qr-video" playsinline muted autoplay style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>`
      : `<div class="scan-bg" style="background-image:url('assets/camera/img-1321.jpg')"></div>`;
    return cShell('/c/scan', `
      <div class="c-top"><a class="icon-btn bare" href="#/" aria-label="ย้อนกลับ" style="color:#fff">${ic('back', 24)}</a><span class="t-h3">สแกน QR บนรถเข็น</span></div>
      <div class="scan-area">${cam}
        <button class="viewfinder" data-act="lc-scan" aria-label="แตะเพื่อเปิดกล้องสแกน QR"><span class="scanline"></span>${C.scan ? '' : ic('qr', 72)}</button>
        <p class="center" style="position:relative;margin:0">วาง QR บนด้ามจับรถเข็นให้อยู่ในกรอบ<br><span class="t-cap" style="opacity:.75">${esc(C.scan?.error ?? (C.scan ? 'กำลังอ่าน QR…' : 'แตะกรอบเพื่อเปิดกล้อง'))}</span></p>
      </div>
      <div class="c-bottom"><button class="btn btn-secondary btn-l btn-block" data-act="lc-manual">กรอกรหัสรถเข็นเอง</button></div>`, { dark: true, overlay: manual });
  }

  function viewWelcome() {
    if (!C.session) return needSession();
    const s = C.session;
    const hl = ['กล้องมองเฉพาะภายในตะกร้า ไม่บันทึกใบหน้า', 'แจ้งได้ทันทีหากรายการไม่ถูกต้อง', 'ชำระเงินที่แคชเชียร์ด้วย QR สรุปยอด'];
    return cShell('/c/welcome', `<div class="c-body"><div class="c-pad" style="flex:1">
        <div>${badge('primary', `รถเข็น #${s.cart} · ${s.store ?? Live.meta?.store?.name_th ?? ''}`)}</div>
        <div class="illus">${ic('cart', 44)}</div>
        <div class="col gap-8"><h1 class="t-h1">สวัสดี! รถเข็น ${esc(s.cart)} พร้อมใช้งาน</h1>
          <p class="t-body-l muted" style="margin:0">วางสินค้าลงในตะกร้าได้ทันที ระบบจะแสดงรายการและราคารวมให้อัตโนมัติ ไม่ต้องสแกนบาร์โค้ด</p></div>
        <div class="col gap-12">${hl.map((t) => `<div class="row gap-12"><span class="check-dot">${ic('check', 14)}</span><span>${t}</span></div>`).join('')}</div>
        <div class="spacer"></div>
        <label class="checkbox"><input type="checkbox" data-change="pdpa" ${state.pdpa ? 'checked' : ''}><span class="box">${ic('check', 14)}</span>
          <span>ฉันยินยอมให้เก็บข้อมูลการซื้อแบบไม่ระบุตัวตน เพื่อวิเคราะห์และปรับปรุงบริการ ตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล (PDPA)</span></label>
      </div></div>
      <div class="c-bottom"><button id="start" class="btn btn-primary btn-l btn-block" data-act="lc-start" ${state.pdpa ? '' : 'disabled'}>เริ่มช้อปปิ้ง</button></div>`);
  }

  function survey(path, step, k, title, desc, opts, cols, next, cta) {
    if (!C.session) return needSession();
    const optHtml = opts.map((o) => `<button class="option ${state[k] === o ? 'on' : ''}" data-act="pick" data-key="${k}" data-val="${esc(o)}" aria-pressed="${state[k] === o}"><span class="radio"></span>${esc(o)}</button>`).join('');
    return cShell(path, `
      <div class="c-top"><a class="icon-btn bare" href="${step === 1 ? '#/c/welcome' : '#/c/gender'}" aria-label="ย้อนกลับ">${ic('back', 24)}</a>
        <span class="t-label muted grow">ขั้นที่ ${step} จาก 2</span><a class="btn btn-ghost btn-m" href="${next}">ข้าม</a></div>
      <div class="progress"><span class="on"></span><span class="${step === 2 ? 'on' : ''}"></span></div>
      <div class="c-body"><div class="c-pad" style="padding:32px 16px 16px">
        <div class="col gap-8"><h1 class="t-h1">${title}</h1><p class="muted" style="margin:0">${desc}</p></div>
        <div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:12px">${optHtml}</div>
      </div></div>
      <div class="c-bottom" style="padding:8px 16px 40px"><button class="btn btn-primary btn-l btn-block" data-act="lc-survey" data-k="${k}" data-next="${next}">${cta}</button></div>`);
  }

  function viewCart() {
    if (!C.session) return needSession();
    const c = { status: C.status, sheet: state.cart.sheet };
    const n = count();
    let banner = '';
    if (c.status === 'updating') banner = `<div class="banner warn">${ic('info', 20)}<div class="col"><span class="title t-strong">กำลังตรวจสอบสินค้า…</span><span class="t-cap">ระบบรอให้ผลตรวจจับนิ่งก่อน (~2 วินาที) ราคาจะไม่เปลี่ยนไปมา</span></div></div>`;
    if (c.status === 'disconnected') banner = `<div class="banner err">${ic('wifioff', 20)}<div class="col"><span class="title t-strong">ขาดการเชื่อมต่อ กำลังเชื่อมต่อใหม่…</span><span class="t-cap">แสดงรายการล่าสุดเมื่อ ${C.lastSync} รายการไม่ถูกล้าง</span></div></div>`;
    if (C.snap?.status && C.snap.status !== 'active') banner = `<div class="banner warn">${ic('check', 20)}<div class="col"><span class="title t-strong">ชำระเงินเรียบร้อยแล้ว</span><span class="t-cap">ขอบคุณที่ใช้บริการ Smart Cart</span></div></div>`;
    const list = [...items(), ...C.ghosts];
    const empty = !list.length;
    const listHtml = empty
      ? `<div class="empty"><div class="illus" style="width:112px;height:112px">${ic('cart', 48)}</div><span class="t-h3">ยังไม่มีสินค้าในตะกร้า</span><span class="muted">วางสินค้าลงในตะกร้าได้เลย ระบบจะเพิ่มรายการและราคาให้อัตโนมัติภายในประมาณ 1 วินาที</span></div>`
      : list.map(row).join('');
    const dim = c.status !== 'connected';
    const closed = C.snap?.status && C.snap.status !== 'active';
    return cShell('/c/cart', `
      <div class="c-head"><div class="grow col"><span class="t-h2">รถเข็น ${esc(C.session.cart)}</span><span class="t-cap muted">เริ่ม ${hhmm(C.session.started_at_ms)} · ${n} ชิ้น</span></div>${pill(c.status)}</div>
      ${banner}
      <div class="list-head"><span class="t-strong grow">รายการสินค้า (${items().length})</span><span class="t-cap muted">จำนวน · รวมย่อย</span></div>
      <div class="item-list">${listHtml}</div>
      <div class="c-bar">
        <div class="row" style="align-items:flex-end"><div class="grow col"><span class="t-strong muted">ราคารวม</span>
          <span class="t-cap" style="color:${c.status === 'updating' ? 'var(--warning-text)' : 'var(--text-2)'}">${c.status === 'updating' ? 'รอระบบยืนยันรายการล่าสุด' : `${n} ชิ้น · รวม VAT แล้ว`}</span></div>
          <span class="t-price" style="color:${dim ? 'var(--text-2)' : 'var(--text)'}" aria-live="polite">${baht(total())}</span></div>
        <div class="actions">${btn('secondary', 'l', 'รายการไม่ถูกต้อง', `data-act="sheet-open" ${closed ? 'disabled' : ''}`)}${btn('primary', 'l', 'จบการซื้อ', `data-act="lc-checkout" ${n === 0 || c.status === 'disconnected' || closed ? 'disabled' : ''}`)}</div>
      </div>`, { overlay: c.sheet ? reportSheet() : '' });
  }

  function reportSheet() {
    const issues = [['missing', 'สินค้าขาดหายไป (มีของแต่ไม่แสดง)'], ['extra', 'มีรายการเกิน (ไม่ได้หยิบ)'], ['wrong_class', 'ชื่อสินค้าไม่ถูกต้อง'], ['wrong_qty', 'จำนวนไม่ถูกต้อง']];
    const opts = [`<option value="">ไม่ระบุ</option>`, ...items().map((i) => `<option value="${esc(i.class_name)}" ${i.class_name === state.cart.issueProduct ? 'selected' : ''}>${esc(i.name)}</option>`)].join('');
    return `<div class="sheet-wrap" data-act="sheet-close-bg"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="grabber"></div>
      <div class="col gap-4"><span id="sheet-title" class="t-h2">แจ้งรายการไม่ถูกต้อง</span><span class="muted">ระบบจะบันทึกภาพเฟรมนี้เพื่อนำไปปรับปรุงโมเดล</span></div>
      <div class="col gap-8">${issues.map(([k, l]) => `<button class="option ${state.cart.issue === k ? 'on' : ''}" data-act="issue" data-val="${k}"><span class="radio"></span>${l}</button>`).join('')}</div>
      <div class="field"><label for="issue-product">สินค้าที่เกี่ยวข้อง (ไม่บังคับ)</label>
        <div class="input">${ic('product')}<select id="issue-product" data-change="issueProduct">${opts}</select></div></div>
      <div class="row gap-12">${btn('secondary', 'l', 'ยกเลิก', 'data-act="sheet-close" style="flex:1"')}${btn('primary', 'l', 'ส่งแจ้งปัญหา', 'data-act="lc-feedback" style="flex:1"')}</div>
    </div></div>`;
  }

  function qr(text, size = 168) {
    if (typeof qrcode === 'undefined') return qrSvg(size);
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount(), m = size / (n + 4);
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${((x + 2) * m).toFixed(2)} ${((y + 2) * m).toFixed(2)}h${m.toFixed(2)}v${m.toFixed(2)}h-${m.toFixed(2)}z`;
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR รหัส ${esc(text)} สำหรับพนักงาน"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#0F172A"/></svg>`;
  }

  function viewSummary() {
    if (!C.session) return needSession();
    const s = C.summary;
    if (!s && !C.summaryLoading) {
      C.summaryLoading = true;
      API.post(`/api/sessions/${C.session.session_id}/summary`)
        .then((r) => { C.summary = r; state.checkoutUntil = r.expires_at_ms; refresh(); })
        .catch((err) => toast('danger', err.message))
        .finally(() => { C.summaryLoading = false; });
    }
    const closed = C.snap?.status && C.snap.status !== 'active';
    const list = s?.items ?? items();
    return cShell('/c/summary', `
      <div class="c-top"><a class="icon-btn bare" href="#/c/cart" aria-label="กลับไปที่ตะกร้า">${ic('back', 24)}</a><span class="t-h3">สรุปยอดการซื้อ</span></div>
      <div class="c-body"><div class="col gap-16" style="padding:8px 16px 16px">
        <div class="card col gap-12" style="padding:24px;align-items:center">${s ? qr(s.checkout_code) : '<div class="sk" style="width:168px;height:168px"></div>'}
          <span class="t-strong center">${closed ? 'ชำระเงินเรียบร้อยแล้ว' : 'แสดง QR นี้ให้พนักงานที่จุดชำระเงิน'}</span><span class="t-label muted num">${esc(s?.checkout_code ?? '…')}</span>
          ${closed ? badge('success', 'ชำระแล้ว') : `<span class="badge b-warning">หมดอายุใน <span data-countdown>${countdownText()}</span></span>`}</div>
        <div class="card col gap-8" style="padding:16px">
          ${list.map((i) => `<div class="row"><span class="grow">${esc(i.name)}</span><span class="muted">×${i.qty}</span><span class="t-strong num">${baht(i.subtotal ?? i.unit_price * i.qty)}</span></div>`).join('')}
          <div style="height:1px;background:var(--border);margin:4px 0"></div>
          <div class="row"><span class="t-strong muted grow">ราคารวม (${s?.item_count ?? count()} ชิ้น)</span><span class="t-price">${baht(s?.total ?? total())}</span></div>
        </div>
        <p class="t-cap muted center" style="margin:0">ยอดจากระบบอาจได้รับการตรวจสอบโดยพนักงานก่อนชำระเงิน</p>
      </div></div>
      <div class="c-bottom" style="padding:8px 16px 40px"><a class="btn btn-secondary btn-l btn-block" href="#/c/cart">กลับไปที่ตะกร้า</a></div>`);
  }

  const viewErrBusy = () => errorView('/c/error-busy', 'cart', 'warning', `รถเข็น ${esc(C.busyCart ?? '')} กำลังถูกใช้งาน`, 'รถเข็นคันนี้มี session ที่ยังไม่จบ หากเป็นของคุณให้กลับไปที่หน้าจอเดิม หรือเลือกรถเข็นคันอื่น', 'CART_IN_USE', 'สแกนรถเข็นคันอื่น', 'ติดต่อพนักงาน');

  // demo panel (right side on wide screens): real scenarios through the real pipeline when INFERENCE_MODE=mock
  function panel(path) {
    const links = C_SCREENS.map(([p, l]) => `<a class="link ${p === path ? 'on' : ''}" href="#${p}">${l}</a>`).join('');
    const demos = [['r01-brand-switch', 'จำลองเปลี่ยนแบรนด์'], ['r07-occluded', 'จำลองสินค้าถูกบัง'], ['r09-model-flip', 'จำลองโมเดลสับสนคลาส'], ['r04-qty-change', 'จำลองลดจำนวน'], ['cart-a-08', 'เล่นรถเข็นตัวอย่าง A-08']];
    const demo = Live.meta?.demo_scenarios
      ? `<div class="card"><span class="t-h3">จำลองระบบ (demo)</span>
          <span class="t-cap muted">${C.session ? `เล่น scenario ผ่าน pipeline จริงของรถเข็น ${esc(C.session.cart)} · admin เห็นเหตุผลบนหน้า Live` : 'เริ่ม session ก่อน (สแกน QR / กรอกรหัสรถเข็น)'}</span>
          ${demos.map(([sc, l]) => `<button class="btn btn-secondary btn-m btn-block" data-act="lc-demo" data-sc="${sc}" ${C.session ? '' : 'disabled'}>${C.demoRunning === sc ? '▶ ' : ''}${l}</button>`).join('')}</div>`
      : `<div class="card"><span class="t-h3">กล้องรถเข็น</span><span class="t-cap muted">ต่อมือถือเป็นกล้อง: npm run device-link -- ${esc(C.session?.cart ?? 'A-07')}</span></div>`;
    return `<aside class="proto-panel" aria-label="แผงควบคุมการสาธิต">
      <div class="card"><span class="t-h3">หน้าจอลูกค้า</span>${links}</div>
      ${demo}
      <div class="card"><span class="t-h3">ฝั่งผู้ดูแล</span><a class="link" href="#/a/login">เปิด Admin Login →</a></div>
    </aside>`;
  }

  // ------------------------------------------------------------ actions
  Object.assign(ACT, {
    'lc-scan': () => {
      if (C.scan) return;
      C.scan = { error: null }; render();
      Scanner.start(document.getElementById('qr-video'), (code) => {
        C.scan = null;
        const m = /[?&]qr=([^&#]+)/.exec(code) ?? /[?&]cart=([^&#]+)/.exec(code);
        start(m ? (code.includes('qr=') ? { qr: decodeURIComponent(m[1]) } : { cart: decodeURIComponent(m[1]) }) : { qr: code.trim() });
      }, (msg) => { if (C.scan) { C.scan.error = msg; render(); } }, { formats: ['qr_code'] });
    },
    'lc-manual': () => { Scanner.stop(); C.scan = null; C.manual = true; render(); document.getElementById('cart-code')?.focus(); },
    'lc-manual-close': () => { C.manual = false; render(); },
    'lc-manual-bg': (el, e) => { if (e.target === el) { C.manual = false; render(); } },
    'lc-manual-go': () => {
      const v = (document.getElementById('cart-code')?.value ?? '').trim().toUpperCase();
      if (!/^[A-Z]-\d{2}$/.test(v)) return toast('warning', 'รหัสรถเข็นต้องเป็นรูปแบบ A-07');
      C.manual = false;
      start({ cart: v });
    },
    'lc-start': async () => {
      try { await API.patch(`/api/sessions/${C.session.session_id}`, { pdpa_consent: true }); go('#/c/gender'); }
      catch (err) { toast('danger', err.message); }
    },
    'lc-survey': async (el) => {
      const k = el.dataset.k, v = state[k];
      if (v) {
        const body = k === 'gender' ? { gender: GENDER[v] } : { age_range: AGE[v] };
        try { await API.patch(`/api/sessions/${C.session.session_id}`, body); } catch (err) { toast('warning', err.message); }
      }
      go(el.dataset.next);
    },
    'lc-feedback': async () => {
      try {
        const cls = document.getElementById('issue-product')?.value || undefined;
        await API.post(`/api/sessions/${C.session.session_id}/feedback`, { issue_type: state.cart.issue, ...(cls ? { class_name: cls } : {}) });
        state.cart.sheet = false; render();
        toast('success', 'ส่งแจ้งปัญหาแล้ว ขอบคุณค่ะ · พนักงานจะตรวจสอบที่จุดชำระเงิน');
      } catch (err) { toast('danger', err.message); }
    },
    'lc-checkout': () => { C.summary = null; go('#/c/summary'); },
    'lc-demo': async (el) => {
      try {
        const r = await API.post('/api/demo/play', { session_id: C.session.session_id, scenario: el.dataset.sc });
        C.demoRunning = r.scenario; refresh();
        toast('info', `กำลังจำลอง ${el.textContent.replace('▶ ', '')} · ${r.seconds} วินาที`);
        setTimeout(() => { if (C.demoRunning === r.scenario) { C.demoRunning = null; refresh(); } }, r.seconds * 1000);
        if (currentPath() !== '/c/cart') go('#/c/cart');
      } catch (err) { toast('danger', err.message); }
    },
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && C.manual) { C.manual = false; render(); } });
  window.addEventListener('hashchange', () => { if (C.scan && currentPath() !== '/c/scan') { Scanner.stop(); C.scan = null; } });

  /** Called by Live.boot: continue a session after reload, or start one from a cart QR link (?qr= / ?cart=). */
  async function boot() {
    const p = new URLSearchParams(location.search);
    await restore();
    if (!C.session && (p.get('qr') || p.get('cart'))) {
      history.replaceState(null, '', location.pathname + location.hash);
      await start(p.get('qr') ? { qr: p.get('qr') } : { cart: p.get('cart').toUpperCase() });
    }
  }

  if (!API.mock) {
    Object.assign(VIEWS, {
      '/c/scan': viewScan, '/c/welcome': viewWelcome, '/c/cart': viewCart, '/c/summary': viewSummary, '/c/error-busy': viewErrBusy,
      '/c/gender': () => survey('/c/gender', 1, 'gender', 'เพศของคุณ', 'ใช้วิเคราะห์ภาพรวมของร้านแบบไม่ระบุตัวตน ข้ามได้หากไม่ต้องการตอบ', Object.keys(GENDER), 1, '#/c/age', 'ถัดไป'),
      '/c/age': () => survey('/c/age', 2, 'age', 'ช่วงอายุของคุณ', 'เลือกช่วงที่ใกล้เคียงที่สุด ข้อมูลนี้ไม่ผูกกับตัวตนของคุณ', Object.keys(AGE), 2, '#/c/cart', 'เริ่มใช้งาน'),
    });
  }
  return { boot, panel };
})();
