'use strict';
/* Admin pages with real data: Dashboard, Live grid + detail (camera frames, hidden items, live reasons),
 * Models (real switch), Sessions (timeline with reasons and evidence frames), Latency (v_frame_latency).
 * Same components as the prototype; mock mode keeps the prototype views (VIEWS are only replaced live).
 */
const LiveAdmin = (() => {
  const PROTO_IMG = new Set(Object.keys(PRODUCTS));
  const A = state.la = {
    overview: {}, abandon: null, cooc: null, reasons: null, carts: null, cartDetail: {}, liveInfo: {}, frame: null,
    lastFrame: {}, thumbs: {}, rendered: {}, seen: new Set(), devModal: null, allCarts: null,
    models: null, inference: null, sessions: null, sessionDetail: {}, latency: {}, loading: new Set(),
  };
  const once = async (key, fn) => {
    if (A.loading.has(key)) return;
    A.loading.add(key);
    try { await fn(); } catch (err) { if (err.status !== 401) toast('danger', err.message); } finally { A.loading.delete(key); }
    render();
  };
  const pimg = (cls, size = 24, radius = 4) => (PROTO_IMG.has(cls)
    ? `<img class="mini-thumb" style="width:${size}px;height:${size}px;border-radius:${radius}px" src="assets/products/${esc(cls)}.jpg" alt="">`
    : `<span class="mini-thumb" style="width:${size}px;height:${size}px;border-radius:${radius}px;display:inline-grid;place-items:center;background:var(--surface-muted);color:var(--text-2)">${ic('product', Math.round(size * 0.6))}</span>`);
  const hhmm = (ms) => (ms ? new Date(ms).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '—');
  const hhmmss = (ms) => (ms ? new Date(ms).toLocaleTimeString('en-GB') : '—');
  const mmss = (ms) => { if (ms == null) return '—'; const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const shortId = (id) => `${id.slice(0, 4)}…${id.slice(-4)}`;
  /** A cart is live while frame signals (live_update with a seq; also the demo feeder) keep arriving. No frame for
   *  STALE_MS = disconnected, even if the phone's socket is still open (paused, screen off, tab closed). */
  const STALE_MS = 5000;
  const isLive = (c) => Date.now() - (A.lastFrame[c.cart] ?? 0) < STALE_MS;
  /** a connected camera gets STALE_MS of grace after a page load before its first frame signal arrives */
  const seedLive = (rows) => { for (const c of rows) if (c.connection === 'connected' && !A.lastFrame[c.cart]) A.lastFrame[c.cart] = Date.now(); };
  const toneOf = { danger: 'danger', warning: 'warning', info: 'primary' };
  const pct = (a, b) => (a == null || b == null || !b ? null : (a - b) / b);
  const delta = (v, digits = 1, unit = '%') => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * (unit === '%' ? 100 : 1)).toFixed(digits)}${unit}`);

  // ------------------------------------------------------------ alerts (bell + dashboard): fill the prototype's ALERTS list
  async function loadAlerts() {
    const { alerts } = await API.get('/api/admin/alerts');
    ALERTS.length = 0;
    for (const a of alerts.slice(0, 8)) ALERTS.push([a.alert_type, toneOf[a.severity] ?? 'neutral', `${a.cart ? a.cart + ' · ' : ''}${a.message.replace(/^[A-Z]-\d{2} · /, '')}`, hhmm(a.created_at_ms)]);
  }

  // ------------------------------------------------------------ dashboard
  function viewDashboard() {
    const range = Math.min(state.range, 2);
    const ov = A.overview[range];
    if (!ov) once(`ov${range}`, async () => { A.overview[range] = await API.get(`/api/admin/analytics/overview?range=${range}`); });
    if (!A.abandon) once('abandon', async () => {
      const [ab, co, rs] = await Promise.all([API.get('/api/admin/analytics/abandon'), API.get('/api/admin/analytics/cooccurrence'), API.get('/api/admin/analytics/reasons')]);
      A.abandon = ab.products; A.cooc = co.pairs; A.reasons = rs;
      await loadAlerts();
    });
    const cur = ov?.current ?? {}, prev = ov?.previous ?? {};
    const kpis = [
      ['Session ทั้งหมด', 'cart', 'เทียบช่วงก่อนหน้า', (cur.sessions ?? 0).toLocaleString('en-US'), delta(pct(cur.sessions, prev.sessions)), 'success'],
      ['ยอดเฉลี่ยต่อรถเข็น', 'product', 'ต่อ session ที่ชำระแล้ว', cur.avg_total != null ? baht(cur.avg_total) : '—', delta(pct(cur.avg_total, prev.avg_total)), 'success'],
      ['เวลา session เฉลี่ย', 'session', 'ต่อ session', cur.avg_duration_ms != null ? `${mmss(cur.avg_duration_ms)} นาที` : '—', delta(pct(cur.avg_duration_ms, prev.avg_duration_ms)), (cur.avg_duration_ms ?? 0) <= (prev.avg_duration_ms ?? 0) ? 'success' : 'warning'],
      ['Cart accuracy', 'check', `รายการตรงกับ POS · ${cur.with_pos ?? 0} session`, cur.cart_accuracy != null ? `${(cur.cart_accuracy * 100).toFixed(1)}%` : '—', cur.cart_accuracy != null && prev.cart_accuracy != null ? `${cur.cart_accuracy >= prev.cart_accuracy ? '+' : '−'}${Math.abs((cur.cart_accuracy - prev.cart_accuracy) * 100).toFixed(1)} pt` : '—', 'success'],
    ].map(([l, icn, note, v, d, tone]) => `<div class="card kpi"><div class="row"><span class="t-label muted grow">${l}</span><span class="tile">${ic(icn, 18)}</span></div>
      <span class="t-h1 num">${v}</span><div class="row">${badge(d === '—' ? 'neutral' : tone, d)}<span class="t-cap muted">${note}</span></div></div>`).join('');
    const vals = ov?.per_hour ?? Array(15).fill(0);
    const top = Math.max(4, Math.ceil(Math.max(...vals) / 4) * 4);
    const peak = vals.indexOf(Math.max(...vals));
    const ab = (A.abandon ?? []).filter((p) => p.added > 0).slice(0, 6);
    const maxRate = Math.max(0.35, ...ab.map((p) => p.abandon_rate ?? 0));
    const co = (A.cooc ?? []).slice(0, 4);
    const rs = A.reasons?.summary ?? [];
    const maxR = Math.max(1, ...rs.map((r) => r.n));
    const toneVar = { primary: 'var(--primary)', success: 'var(--success)', warning: 'var(--warning)', neutral: 'var(--text-2)', danger: 'var(--danger)' };
    const days = ['วันนี้', '7 วันล่าสุด', '30 วันล่าสุด'][range];
    return aShell('dashboard', `
      ${pageTitle('Dashboard', `ภาพรวมร้าน · ${esc(Live.meta?.store?.name_th ?? '')} · active ${ov?.active_sessions ?? 0} session · อัปเดต ${hhmm(ov?.to)}`, seg('range', ['วันนี้', '7 วัน', '30 วัน'], range) + `<span class="btn btn-secondary btn-m" style="cursor:default">${ic('calendar', 16)}${days}</span>`)}
      <div class="kpis">${kpis}</div>
      <div class="grid-2">
        <div class="card card-pad">${cardHead('Session ต่อชั่วโมง', `เฉลี่ยต่อวัน · shopping_sessions · ${days}`, vals.some((v) => v) ? badge('primary', `สูงสุด ${String(peak + 8).padStart(2, '0')}:00 น.`) : '')}
          ${lineChart({ vals, min: 0, max: top, yl: [top, top * 0.75, top / 2, top / 4, 0].map((v) => String(Math.round(v * 10) / 10)), xl: ['08', '10', '12', '14', '16', '18', '20', '22'], peak, peakLabel: `${String(peak + 8).padStart(2, '0')}:00 · ${vals[peak]} session`, label: 'จำนวน session ต่อชั่วโมง' })}</div>
        <div class="card card-pad">${cardHead('อัตราเปลี่ยนใจต่อสินค้า', 'REMOVE ÷ ADD · v_product_abandon (เฉพาะ event อัตโนมัติ)')}
          <div class="col gap-12">${ab.length ? ab.map((p) => `<div class="col gap-4"><div class="row">${pimg(p.class_name)}<span class="t-cap grow">${esc(p.name_th)}</span><span class="t-cap muted">${p.removed}/${p.added}</span><span class="t-cap-strong">${Math.round((p.abandon_rate ?? 0) * 100)}%</span></div>
            <div class="bar-track"><span style="width:${((p.abandon_rate ?? 0) / maxRate) * 100}%;background:${(p.abandon_rate ?? 0) >= 0.2 ? 'var(--danger)' : 'var(--primary)'}"></span></div></div>`).join('') : '<span class="muted">ยังไม่มีการหยิบเข้า–ออก</span>'}</div></div>
      </div>
      <div class="grid-2">
        <div class="card card-pad">${cardHead('เหตุผลการเปลี่ยนสินค้า', 'change_reasons (final) · ทั้งหมด')}
          <div class="col gap-12">${rs.length ? rs.map((r) => `<div class="col gap-4"><div class="row">${badge(r.tone, r.label_th)}<span class="t-cap grow muted">dwell เฉลี่ย ${r.avg_dwell_s ?? '—'} วิ${r.avg_price_delta != null ? ` · ส่วนต่างราคา ${r.avg_price_delta >= 0 ? '+' : ''}${baht(r.avg_price_delta)}` : ''}</span><span class="t-cap-strong">${r.n}</span></div>
            <div class="bar-track"><span style="width:${(r.n / maxR) * 100}%;background:${toneVar[r.tone]}"></span></div></div>`).join('') : '<span class="muted">ยังไม่มีเหตุผลที่ยืนยันแล้ว</span>'}</div></div>
        <div class="card card-pad">${cardHead('คู่ที่เปลี่ยนบ่อย', 'จาก → ไป · จำนวนครั้ง · ส่วนต่างราคาเฉลี่ย')}
          <div class="table-wrap"><table class="table"><thead><tr><th>จาก</th><th>ไป</th><th>เหตุผล</th><th class="r">ครั้ง</th><th class="r">ส่วนต่าง</th></tr></thead><tbody>
          ${(A.reasons?.pairs ?? []).slice(0, 6).map((p) => `<tr><td>${esc(p.from_name)}</td><td>${esc(p.to_name)}</td><td>${badge({ BRAND_SWITCH: 'primary', FLAVOR_SWITCH: 'success', VARIANT_SWITCH: 'warning', QTY_CHANGE: 'neutral', ABANDON: 'danger' }[p.reason_code], p.reason_code)}</td><td class="r num">${p.n}</td><td class="r num">${p.avg_price_delta != null ? baht(p.avg_price_delta) : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">ยังไม่มีข้อมูล</td></tr>'}
          </tbody></table></div></div>
      </div>
      <div class="grid-2">
        <div class="card card-pad">${cardHead('สินค้าที่ซื้อคู่กัน', 'v_cooccurrence · support และ lift (lift ≥ 2 = ซื้อคู่กันบ่อยผิดปกติ)')}
          <div class="table-wrap"><table class="table"><thead><tr><th>สินค้า A</th><th>สินค้า B</th><th class="r">Session ร่วม</th><th class="r">Support</th><th class="r">Lift</th></tr></thead><tbody>
          ${co.map((x) => `<tr><td>${esc(x.name_a)}</td><td>${esc(x.name_b)}</td><td class="r num">${x.sessions_together}</td><td class="r num">${Number(x.support).toFixed(2)}</td><td class="r">${badge(x.lift >= 2 ? 'success' : 'primary', Number(x.lift).toFixed(2))}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">ยังไม่มี session ที่ชำระแล้ว</td></tr>'}
          </tbody></table></div></div>
        <div class="card card-pad">${cardHead('Alerts ล่าสุด', 'ตาราง alerts', '<a class="btn btn-ghost btn-m" href="#/a/live">ดู Live</a>')}
          <div class="col gap-8">${ALERTS.length ? ALERTS.map(([t, tone, msg, tm]) => `<div class="row">${badge(tone, t)}<span class="t-cap grow">${esc(msg)}</span><span class="t-cap muted">${tm}</span></div>`).join('') : '<span class="muted">ไม่มี alert ที่ค้างอยู่</span>'}</div></div>
      </div>`);
  }

  // ------------------------------------------------------------ live grid
  const camBox = (label, { aspect, small = false, body = '', live = true }) => `<div class="cam ${small ? 'cam-sm' : ''}" style="aspect-ratio:${aspect}">${body}
    <div class="cam-tag"><span class="live" ${live ? '' : 'style="background:#64748B;animation:none"'}></span>${live ? 'LIVE' : 'OFFLINE'} · ${esc(label)}</div></div>`;

  /** Live grid camera: the newest JPEG of the phone (<img data-live-cart>, src patched by refreshThumb without a
   *  re-render), or the "no camera" placeholder. Only the image src changes per frame, never the page. */
  function cardCam(c, info, connected) {
    const th = A.thumbs[c.cart];
    const off = `<div class="cam-off" style="background:var(--inverse)">${ic(connected ? 'live' : 'wifioff', 28)}<span>${connected ? `${info.detections ?? 0} กล่องใน ROI · ${info.fps ?? 0} fps` : 'กล้องไม่ได้เชื่อมต่อ'}</span></div>`;
    const img = connected ? `<img data-live-cart="${esc(c.cart)}" ${th?.url ? `src="${th.url}"` : ''} alt="ภาพสดจากกล้องรถเข็น ${esc(c.cart)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;${th?.url ? '' : 'display:none'}">` : '';
    return off + img;
  }

  function viewLive() {
    // all carts, shown when they have a session, a camera, or had a live camera while this page was open
    // (so a phone that goes away turns its card "ขาดการเชื่อมต่อ" instead of making it vanish)
    if (!A.carts) once('carts', async () => {
      const r = await API.get('/api/admin/carts?all=1');
      seedLive(r.carts);
      A.carts = r.carts.filter((c) => c.session || c.connection === 'connected' || A.lastFrame[c.cart] !== undefined || A.seen.has(c.cart));
      await loadAlerts();
    });
    const carts = A.carts ?? [];
    const f = state.liveFilter === 'all' ? 0 : state.liveFilter;
    const withAlert = carts.filter((c) => c.alert), offline = carts.filter((c) => !isLive(c));
    const list = f === 1 ? withAlert : f === 2 ? offline : carts;
    const cards = list.map((c) => {
      const s = c.session, info = A.liveInfo[c.cart] ?? {};
      const items = (info.items ?? s?.items ?? []);
      const total = info.total ?? s?.total ?? 0;
      const connected = isLive(c);
      const st = !connected ? 'disconnected' : info.state === 'updating' ? 'updating' : 'connected';
      const alertCls = c.alert ? (c.alert.severity === 'danger' ? 'err' : 'warn') : '';
      A.rendered[c.cart] = connected;
      const body = cardCam(c, info, connected);
      return `<a class="card cart-card ${alertCls}" href="#/a/live/${c.cart}" aria-label="เปิดรถเข็น ${c.cart}">
        ${camBox(c.cart, { aspect: 2.4, small: true, body, live: connected })}
        <div class="col gap-8" style="padding:12px 16px">
          <div class="row"><span class="t-strong grow">รถเข็น ${c.cart}</span>${pill(st)}</div>
          <div class="col gap-4">${items.slice(0, 2).map((i) => `<div class="row">${pimg(i.class_name, 20)}<span class="t-cap grow">${esc(i.name)} ×${i.qty}</span><span class="t-cap muted num">${baht(i.subtotal ?? 0)}</span></div>`).join('') || `<span class="t-cap muted">${s ? 'ยังไม่มีสินค้า' : 'ไม่มี session'}</span>`}
            ${items.length > 2 ? `<span class="t-cap-strong" style="color:var(--primary)">+${items.length - 2} รายการ</span>` : ''}</div>
          <div class="row"><span class="t-h3 grow num">${baht(total)}</span><span data-live-ms="${c.cart}">${msBadge(info)}</span><span class="t-cap muted" data-upd-live="${c.cart}">${info.t ? `อัปเดต ${Math.max(0, Math.round((Date.now() - info.t) / 1000))} วิ` : '—'}</span></div>
          ${info.reason ? `<div class="row">${badge(info.reason.tone, info.reason.label_th)}<span class="t-cap grow trunc">${esc(info.reason.from?.name_th ?? '')}${info.reason.to ? ' → ' + esc(info.reason.to.name_th) : ''}</span></div>` : ''}
        </div>
        ${c.alert ? `<div class="alert-bar ${alertCls}">${ic('alert', 16)}<span>${esc(c.alert.alert_type)} · ${esc(c.alert.message)}</span></div>` : ''}</a>`;
    }).join('');
    const sel = f;
    const addBtn = isStaff() ? '' : btn('primary', 'm', 'เพิ่ม device (กล้องมือถือ)', 'data-act="dev-open"', 'qr');
    return aShell('live', `
      ${pageTitle('Live รถเข็น', `Active ${carts.filter((c) => c.session).length} คัน · กล้องต่ออยู่ ${carts.filter(isLive).length} คัน · /ws/admin ทุก ~250 ms`, `<div class="row wrap gap-8">${seg('live-filter', [`ทั้งหมด (${carts.length})`, `มี alert (${withAlert.length})`, `ขาดการเชื่อมต่อ (${offline.length})`], sel)}${addBtn}</div>`)}
      <div class="cart-grid">${cards || `<p class="muted">${A.carts ? 'ยังไม่มีรถเข็นที่มีลูกค้าหรือกล้องต่ออยู่ · กด "เพิ่ม device (กล้องมือถือ)" เพื่อต่อกล้อง' : 'กำลังโหลด…'}</p>`}</div>
      ${A.devModal ? deviceModal() : ''}`);
  }
  const msBadge = (info) => badge(info.server_ms > 300 ? 'warning' : 'neutral', info.server_ms != null ? `${info.server_ms} ms` : '— ms');

  // ------------------------------------------------------------ live grid thumbnails (no re-render per frame)
  /** Load GET /api/admin/carts/:label/latest.jpg after a live_update with a new seq; one request in flight per cart. */
  async function refreshThumb(cart, seq) {
    const th = (A.thumbs[cart] ??= { url: null, seq: -1, busy: false });
    if (th.busy || seq === th.seq) return;
    const sel = `img[data-live-cart="${CSS.escape(cart)}"]`;
    if (!document.querySelector(sel)) return; // card not on screen
    th.busy = true;
    try {
      const res = await fetch(`/api/admin/carts/${encodeURIComponent(cart)}/latest.jpg?seq=${seq}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      const url = URL.createObjectURL(await res.blob());
      const pre = new Image();
      pre.src = url;
      await pre.decode().catch(() => {}); // swap only a decoded image: no blank frame between two JPEGs
      const old = th.url;
      th.url = url;
      th.seq = Number(res.headers.get('X-Frame-Seq')) || seq;
      for (const el of document.querySelectorAll(sel)) { el.src = url; el.style.display = ''; }
      if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
    } catch { /* offline: keep the last picture */ } finally { th.busy = false; }
  }
  function dropThumb(cart) {
    const th = A.thumbs[cart];
    if (th?.url) URL.revokeObjectURL(th.url);
    delete A.thumbs[cart];
  }

  // ------------------------------------------------------------ "เพิ่ม device (กล้องมือถือ)": QR of device.html for a cart
  // The token comes from POST /api/admin/carts/:label/device-token (admin session) and is shown only in this modal:
  // nothing secret lives in the page source. A new token makes the cart's previous camera link invalid.
  const FPS = [2, 3, 4, 5];
  const isLocalHost = (u) => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname); } catch { return true; } };
  const savedBase = () => { try { return localStorage.getItem('sc-device-base') || ''; } catch { return ''; } };
  function deviceUrl(m) {
    const base = (m.base || '').replace(/\/+$/, '');
    return `${base}/device.html?${new URLSearchParams({ cart: m.result.cart, fps: String(m.fps), token: m.result.token })}`;
  }
  function qrSvgReal(text, size = 220) {
    if (typeof qrcode === 'undefined') return '<span class="muted">โหลดไลบรารี QR ไม่ได้ · ใช้ลิงก์ด้านล่างแทน</span>';
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount(), m = size / (n + 8);
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${((x + 4) * m).toFixed(2)} ${((y + 4) * m).toFixed(2)}h${m.toFixed(2)}v${m.toFixed(2)}h-${m.toFixed(2)}z`;
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR ลิงก์กล้องรถเข็น"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#0F172A"/></svg>`;
  }
  function deviceModal() {
    const m = A.devModal;
    const carts = A.allCarts ?? [];
    const opts = carts.map((c) => `<option value="${esc(c.cart)}" ${c.cart === m.cart ? 'selected' : ''}>${esc(c.cart)}${c.connection === 'connected' ? ' · กล้องต่ออยู่' : ''}</option>`).join('') || `<option>${esc(m.cart)}</option>`;
    const url = m.result ? deviceUrl(m) : '';
    const warn = !m.result ? ''
      : isLocalHost(m.base) ? `<div class="banner err" style="margin:0">${ic('alert', 20)}<span class="t-cap">มือถือเปิด localhost ของเครื่องนี้ไม่ได้ · ใส่ https://&lt;IP เครื่อง&gt;:8443 (หลัง npm run lan-https) หรือ URL ของ cloudflared tunnel แล้ว QR จะเปลี่ยนตาม</span></div>`
      : !/^https:/i.test(m.base) ? `<div class="banner warn" style="margin:0">${ic('alert', 20)}<span class="t-cap">มือถือเปิดกล้องได้เฉพาะหน้า https:// · ใช้ https://&lt;IP&gt;:8443 หรือ cloudflared</span></div>` : '';
    return `<div class="backdrop" data-act="dev-close-bg"><div class="modal sm" role="dialog" aria-modal="true" aria-labelledby="dev-title">
      <div class="row"><span id="dev-title" class="t-h2 grow">เพิ่ม device (กล้องมือถือ)</span><button class="icon-btn bare" data-act="dev-close" aria-label="ปิด">${ic('close')}</button></div>
      <span class="muted">สแกน QR ด้วยมือถือที่จะติดบนรถเข็น แล้วกด "เริ่มส่งภาพ" ภาพจะขึ้นในการ์ดของรถเข็นนั้นภายในไม่กี่วินาที</span>
      <div class="row gap-12">
        <div class="field grow"><label for="dev-cart">รถเข็น</label><div class="input"><select id="dev-cart" data-dev="cart">${opts}</select></div></div>
        <div class="field" style="width:120px"><label for="dev-fps">อัตราเฟรม</label><div class="input"><select id="dev-fps" data-dev="fps">${FPS.map((f) => `<option value="${f}" ${f === m.fps ? 'selected' : ''}>${f} fps</option>`).join('')}</select></div></div>
      </div>
      ${m.result ? `<div class="col gap-12" style="align-items:center">${qrSvgReal(url)}</div>
        <div class="field"><label for="dev-base">ที่อยู่ server ที่มือถือเข้าถึงได้</label><div class="input"><input id="dev-base" data-dev="base" value="${esc(m.base)}" spellcheck="false" autocomplete="off"></div></div>
        ${warn}
        <div class="field"><label for="dev-url">ลิงก์ (มี token ของกล้อง อย่าแชร์ในที่สาธารณะ)</label><div class="input"><input id="dev-url" value="${esc(url)}" readonly></div></div>
        <span class="t-cap muted">token ของรถเข็น ${esc(m.result.cart)} ถูกสร้างใหม่แล้ว ลิงก์/QR เก่าของคันนี้จะเชื่อมต่อใหม่ไม่ได้ (เครื่องที่ต่ออยู่ยังส่งต่อได้)</span>`
      : `<div class="banner warn" style="margin:0">${ic('info', 20)}<span class="t-cap">การสร้าง QR จะออก token ใหม่ให้รถเข็นที่เลือก ลิงก์กล้องเดิมของคันนั้นจะใช้ต่อใหม่ไม่ได้</span></div>`}
      <div class="row" style="justify-content:flex-end;gap:8px">${btn('secondary', 'm', 'ปิด', 'data-act="dev-close"')}
        ${m.result ? btn('secondary', 'm', 'คัดลอกลิงก์', 'data-act="dev-copy"') : ''}
        ${btn('primary', 'm', m.busy ? 'กำลังสร้าง…' : m.result ? 'สร้าง QR ใหม่' : 'สร้าง QR', `data-act="dev-issue" ${m.busy ? 'disabled' : ''}`, 'qr')}</div>
    </div></div>`;
  }
  ACT['dev-open'] = () => {
    A.devModal = { cart: (A.carts ?? []).find((c) => !isLive(c))?.cart ?? 'A-07', fps: 4, base: '', result: null, busy: false };
    render();
    once('all-carts', async () => {
      A.allCarts = (await API.get('/api/admin/carts?all=1')).carts;
      if (A.devModal && !A.allCarts.some((c) => c.cart === A.devModal.cart)) A.devModal.cart = A.allCarts[0]?.cart ?? A.devModal.cart;
    });
  };
  ACT['dev-close'] = () => { A.devModal = null; render(); };
  ACT['dev-close-bg'] = (el, e) => { if (e.target === el) { A.devModal = null; render(); } };
  ACT['dev-issue'] = async () => {
    const m = A.devModal;
    if (!m || m.busy) return;
    m.busy = true; render();
    try {
      const r = await API.post(`/api/admin/carts/${encodeURIComponent(m.cart)}/device-token`);
      // phone-reachable origin: what the admin typed before > this page if it is not localhost > server's LAN/PUBLIC_URL
      m.base = savedBase() || (!isLocalHost(location.origin) ? location.origin : r.base_url || location.origin);
      m.result = { cart: r.cart, token: r.token };
    } catch (err) { toast('danger', err.status === 403 ? 'สร้าง QR ได้เฉพาะ admin' : err.message); }
    m.busy = false;
    if (A.devModal === m) render();
  };
  ACT['dev-copy'] = async () => {
    const m = A.devModal;
    if (!m?.result) return;
    try { await navigator.clipboard.writeText(deviceUrl(m)); toast('success', 'คัดลอกลิงก์แล้ว'); }
    catch { document.getElementById('dev-url')?.select(); toast('info', 'เลือกลิงก์ไว้แล้ว กด Ctrl+C เพื่อคัดลอก'); }
  };
  document.addEventListener('change', (e) => {
    const k = e.target.dataset?.dev;
    const m = A.devModal;
    if (!k || !m) return;
    if (k === 'cart') { m.cart = e.target.value; m.result = null; } // new cart = new token (press สร้าง QR)
    if (k === 'fps') m.fps = Number(e.target.value);
    if (k === 'base') { m.base = e.target.value.trim(); try { localStorage.setItem('sc-device-base', m.base); } catch { /* private mode */ } }
    render();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && A.devModal) { A.devModal = null; render(); } });

  // ------------------------------------------------------------ live detail
  let watching = null, frameUrl = null;
  function viewLiveDetail(label) {
    if (watching !== label) { watching = label; A.frame = null; API.watch(label); }
    const d = A.cartDetail[label];
    if (!d) once(`cart-${label}`, async () => { const r = await API.get(`/api/admin/carts/${encodeURIComponent(label)}`); seedLive([r]); A.cartDetail[label] = r; });
    if (d) A.rendered[label] = isLive(d);
    if (!d) return aShell('live', '<p class="muted">กำลังโหลด…</p>');
    const s = d.session;
    const tl = s ? A.sessionDetail[s.session_id] : null;
    if (s && !tl) once(`sess-${s.session_id}`, async () => { A.sessionDetail[s.session_id] = await API.get(`/api/admin/sessions/${s.session_id}`); });
    const t = state.toggles;
    const camCls = [t.boxes ? '' : 'hide-boxes', t.roi ? '' : 'hide-roi', t.outside ? '' : 'hide-outside'].join(' ');
    const toggle = (k, l) => `<button class="toggle ${t[k] ? 'on' : ''}" data-act="toggle" data-k="${k}" aria-pressed="${t[k]}"><span class="sw"><i></i></span>${l}</button>`;
    const fr = A.frame?.cart === label ? A.frame : null;
    const occluded = (s?.presence ?? []).filter((p) => p.state === 'OCCLUDED');
    const dets = fr ? fr.detections : [];
    const inRoi = dets.filter((x) => x.in_roi);
    const detList = !fr ? `<span class="muted">${d.connection === 'connected' ? 'รอเฟรมแรก…' : 'กล้องไม่ได้เชื่อมต่อ'}</span>`
      : dets.map((x) => `<div class="row">${pimg(x.class_name, 32, 6)}<span class="t-cap grow trunc" title="${esc(x.class_name)}">${esc(x.class_name)}</span>
        <span class="bar-track" style="width:56px;height:6px;flex:none"><span style="width:${x.conf * 100}%;background:${x.accepted ? 'var(--success)' : 'var(--warning)'}"></span></span>
        <span class="t-cap-strong num">${x.conf.toFixed(2)}</span>${badge(x.in_roi ? 'success' : 'danger', x.in_roi ? 'ROI' : 'นอก ROI')}</div>`).join('') || '<span class="muted">ไม่พบวัตถุในเฟรมนี้</span>';
    const items = s?.items ?? [];
    const occCount = (cls) => occluded.filter((p) => p.class_name === cls).length;
    const reasons = (s?.reasons ?? []).slice().reverse();
    const events = (tl?.events ?? []).filter((e) => ['ADD', 'REMOVE', 'CORRECTION'].includes(e.event_type));
    const reasonByRemove = new Map((tl?.reasons ?? []).filter((r) => r.remove_event_id).map((r) => [r.remove_event_id, r]));
    return aShell('live', `
      <div class="page-title"><a class="btn btn-ghost btn-m" href="#/a/live">${ic('back', 16)}Live</a>
        <div class="grow col"><h1 class="t-h1">รถเข็น ${esc(label)}</h1><span class="muted">${s ? `session ${shortId(s.session_id)} · เริ่ม ${hhmm(s.started_at_ms)}` : 'ไม่มี session (แสดงภาพเพื่อตั้ง ROI ได้ ไม่บันทึก)'} · ${esc(Live.meta?.active_model?.name ?? '')} · conf ≥ ${(Live.meta?.active_model?.conf_threshold ?? 0.7).toFixed(2)}</span></div>
        ${pill(isLive(d) ? 'connected' : 'disconnected')}${badge('neutral', fr ? `${A.liveInfo[label]?.fps ?? '—'} fps · ${fr.w ?? 640}×${fr.h ?? 480}` : '— fps')}</div>
      <div class="grid-detail">
        <div class="card col gap-12" style="padding:16px">
          <div class="cam ${camCls}" style="aspect-ratio:${fr?.w && fr?.h ? `${fr.w}/${fr.h}` : '4/3'}" id="live-cam">${liveCamInner(fr, d, occluded)}</div>
          <div class="row wrap gap-12">${toggle('boxes', 'แสดงกรอบ (bounding box)')}${toggle('roi', 'แสดง ROI ตะกร้า')}${toggle('outside', 'แสดงนอก ROI')}
            <span class="spacer"></span><span class="t-cap muted">เส้นประเหลือง = ROI · กรอบแดง = นอก ROI · เส้นประส้ม = ชิ้นที่ถูกบัง</span></div>
        </div>
        <div class="col gap-16">
          <div class="card card-pad">${cardHead('Detections (เฟรมนี้)', `${dets.length} กล่อง · ${inRoi.length} ใน ROI · conf ≥ ${(Live.meta?.active_model?.conf_threshold ?? 0.7).toFixed(2)}`)}<div class="col" style="gap:10px" id="live-dets">${detList}</div></div>
          <div class="card card-pad">${cardHead('รายการ (stable)', 'presence รายชิ้น · tracker W=8, K=3' + (A.liveInfo[label]?.state === 'updating' ? ' · มีรายการรอยืนยัน' : ''))}
            <div class="col gap-8">${items.map((i) => `<div class="row"><span class="t-cap grow">${esc(i.name)} ×${i.qty}</span>${occCount(i.class_name) ? badge('warning', `ถูกบัง ${occCount(i.class_name)}`) : ''}<span class="t-cap-strong num">${baht(i.subtotal)}</span></div>`).join('') || '<span class="t-cap muted">ยังไม่มีสินค้า</span>'}
            <div class="row" style="margin-top:4px"><span class="t-strong muted grow">ราคารวม</span><span class="t-h2 num">${baht(s?.total ?? 0)}</span></div></div></div>
          <div class="card card-pad">${cardHead('เหตุผลการเปลี่ยนสินค้า (สด)', 'change_reasons · จับคู่ ±60 วินาที · rule v1')}
            <div class="col gap-8">${reasons.map((r) => `<div class="col gap-4" style="padding:8px 12px;border-radius:8px;background:var(--bg)">
              <div class="row">${badge(r.tone, r.label_th)}<span class="t-cap grow">${esc(r.from_name ?? '')}${r.to_name && r.to_class !== r.from_class ? ` → ${esc(r.to_name)}` : ''}</span>${r.status === 'pending' ? badge('neutral', 'รอดูสินค้าที่หยิบแทน…') : r.status === 'voided' ? badge('neutral', 'ยกเลิก') : ''}</div>
              <span class="t-cap muted">${r.qty_before != null ? `จำนวน ${r.qty_before} → ${r.qty_after}` : ''}${r.price_delta != null ? ` · ส่วนต่าง ${r.price_delta >= 0 ? '+' : ''}${baht(r.price_delta)}` : ''}${r.dwell_ms != null ? ` · อยู่ในรถเข็น ${Math.round(r.dwell_ms / 1000)} วิ` : ''}${r.gap_ms != null ? ` · ห่าง ${Math.round(r.gap_ms / 1000)} วิ` : ''} · ${hhmmss(r.decided_at_ms)}</span></div>`).join('') || '<span class="t-cap muted">ยังไม่มีการเปลี่ยนสินค้าใน session นี้</span>'}</div></div>
        </div>
      </div>
      <div class="card card-pad">${cardHead('Timeline ADD / REMOVE', 'cart_events · ภาพหลักฐาน ณ เหตุการณ์ (frames.image_path)')}
        <div class="row wrap gap-8">${events.map((e) => { const r = reasonByRemove.get(e.event_id); return `<span class="chip">${pimg(e.class_name, 32, 6)}${badge({ ADD: 'success', REMOVE: 'danger', CORRECTION: 'warning' }[e.event_type], e.event_type)}<span class="t-cap">${esc(e.class_name ?? '')} ${e.qty_delta > 0 ? '+' : '−'}${Math.abs(e.qty_delta)}</span>${r ? badge(r.tone, r.label_th) : ''}<span class="t-cap muted">${hhmmss(e.occurred_at_ms)}</span></span>`; }).join('') || '<span class="t-cap muted">ยังไม่มีเหตุการณ์</span>'}</div></div>`);
  }

  function liveCamInner(fr, d, occluded) {
    const roi = (fr?.roi ?? d.roi_polygon ?? []).map(([x, y]) => `${x * 100},${y * 100}`).join(' ');
    const det = (x) => `<div class="det c-${!x.in_roi ? 'd' : x.accepted ? 'p' : 'w'} ${x.in_roi ? '' : 'outside'}" style="left:${x.box[0] * 100}%;top:${x.box[1] * 100}%;width:${(x.box[2] - x.box[0]) * 100}%;height:${(x.box[3] - x.box[1]) * 100}%"><span>${esc(x.class_name)} ${x.conf.toFixed(2)}${x.in_roi ? '' : ' · นอก ROI'}</span></div>`;
    const occ = occluded.filter((p) => p.last_box).map((p) => `<div class="det det-occluded" style="left:${p.last_box[0] * 100}%;top:${p.last_box[1] * 100}%;width:${(p.last_box[2] - p.last_box[0]) * 100}%;height:${(p.last_box[3] - p.last_box[1]) * 100}%"><span>${esc(p.class_name)} · ถูกบัง${p.occluded_by ? ` (${esc(p.occluded_by)})` : ''}</span></div>`).join('');
    const img = fr?.url ? `<img src="${fr.url}" alt="ภาพจากกล้องรถเข็น ${esc(d.cart)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:fill">`
      : `<div class="cam-off">${ic(d.connection === 'connected' ? 'live' : 'wifioff', 28)}<span>${d.connection === 'connected' ? 'กำลังรอภาพจากกล้อง…' : 'กล้องไม่ได้เชื่อมต่อ · npm run device-link -- ' + esc(d.cart)}</span></div>`;
    return `<div class="cam-stage" style="inset:0;width:100%;height:100%">${img}
      <svg class="roi" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon points="${roi}" fill="none" stroke="#F59E0B" stroke-width="2" stroke-dasharray="8 6" vector-effect="non-scaling-stroke"/></svg>
      ${(fr?.detections ?? []).map(det).join('')}${occ}</div>
      <div class="cam-tag"><span class="live" ${fr ? '' : 'style="background:#64748B;animation:none"'}></span>${fr ? 'LIVE' : 'OFFLINE'} · ${esc(d.cart)}${fr ? ` · #${fr.seq}` : ''}</div>`;
  }

  // binary frame: JSON header + "\n" + JPEG — patch only the camera and detections (no full re-render at 4 fps)
  API.on('frame', async (blob) => {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const nl = buf.indexOf(10);
    if (nl < 0) return;
    const header = JSON.parse(new TextDecoder().decode(buf.subarray(0, nl)));
    if (header.cart !== watching) return;
    if (frameUrl) URL.revokeObjectURL(frameUrl);
    frameUrl = URL.createObjectURL(new Blob([buf.subarray(nl + 1)], { type: 'image/jpeg' }));
    const first = !A.frame;
    A.frame = { ...header, url: frameUrl };
    const cam = document.getElementById('live-cam');
    const d = A.cartDetail[watching];
    if (!cam || !d || first) return render();
    cam.innerHTML = liveCamInner(A.frame, d, (d.session?.presence ?? []).filter((p) => p.state === 'OCCLUDED'));
  });

  window.addEventListener('hashchange', () => {
    const m = currentPath().match(/^\/a\/live\/(.+)$/);
    if (!m && watching) { watching = null; A.frame = null; API.watch(null); }
    if (currentPath() === '/a/live') A.carts = null;
  });

  // live messages from the pipeline
  // at most one render per 300 ms; a steady 250 ms live_update stream must not postpone it forever (old debounce did)
  let pending = null;
  const soon = (fn) => { if (!pending) pending = setTimeout(() => { pending = null; fn(); }, 300); };
  /** what a grid card shows besides the camera: re-render only when this changes, not for every frame */
  const cardSig = (i) => JSON.stringify([(i.items ?? []).map((x) => [x.class_name, x.qty]), i.total, i.state, i.reason?.label_th]);
  API.on('live_update', (m) => {
    if (m.event === 'session_started' || m.event === 'session_closed') { A.carts = null; delete A.cartDetail[m.cart]; return soon(render); }
    const prev = A.liveInfo[m.cart] ?? {};
    const wasLive = Date.now() - (A.lastFrame[m.cart] ?? 0) < STALE_MS;
    A.liveInfo[m.cart] = { ...prev, ...m, t: Date.now() };
    A.lastFrame[m.cart] = Date.now();
    A.seen.add(m.cart);
    if (currentPath() !== '/a/live') return;
    if (A.devModal) return void (m.seq != null && refreshThumb(m.cart, m.seq)); // keep the modal's fields intact
    // a camera that is online but not in the list yet (just connected) -> reload the list so its card appears
    if (A.carts && !A.carts.some((c) => c.cart === m.cart)) { A.carts = null; return soon(render); }
    if (!wasLive || A.rendered[m.cart] === false || cardSig(prev) !== cardSig(A.liveInfo[m.cart])) soon(render);
    else { const el = document.querySelector(`[data-live-ms="${CSS.escape(m.cart)}"]`); if (el) el.innerHTML = msBadge(A.liveInfo[m.cart]); }
    if (m.seq != null) refreshThumb(m.cart, m.seq);
  });
  const refreshCart = (m) => {
    delete A.cartDetail[m.cart];
    if (m.session_id) delete A.sessionDetail[m.session_id];
    A.overview = {}; A.abandon = null;
    const p = currentPath();
    if (p === `/a/live/${m.cart}` || p === '/a/live' || p === '/a/dashboard') soon(render);
  };
  API.on('cart_event', refreshCart);
  API.on('presence', refreshCart);
  API.on('change_reason', (m) => {
    A.liveInfo[m.cart] = { ...(A.liveInfo[m.cart] ?? {}), reason: m };
    if (m.status === 'final') toast('info', `${m.cart} · ${m.label_th}: ${m.from?.name_th ?? ''}${m.to && m.to.class_name !== m.from?.class_name ? ' → ' + m.to.name_th : ''}`);
    refreshCart(m);
  });
  API.on('alert', async () => { try { await loadAlerts(); } catch { /* offline */ } if (currentPath().startsWith('/a/')) soon(render); });
  API.on('device_status', (m) => {
    A.seen.add(m.cart);
    if (m.connection === 'connected') A.lastFrame[m.cart] = Date.now(); // grace until its first frame
    else { delete A.lastFrame[m.cart]; dropThumb(m.cart); }
    A.carts = null; A.allCarts = null; delete A.cartDetail[m.cart];
    if (currentPath().startsWith('/a/live')) soon(render);
  });
  API.on('model_changed', () => { A.models = null; Live.refreshMeta?.(); if (currentPath() === '/a/models') soon(render); });

  // ------------------------------------------------------------ models
  function viewModels() {
    if (!A.models) once('models', async () => {
      const [m, inf] = await Promise.all([API.get('/api/admin/models'), API.get('/api/admin/inference')]);
      A.models = m; A.inference = inf;
      MODELS.length = 0;
      for (const x of m.models) MODELS.push({ name: x.name, family: x.family, size: x.size ?? '—', format: x.format, map: x.map50_95 ?? 0, p95: x.latency_p95_ms ?? 0, params: x.params ?? '—', gflops: x.gflops });
      state.activeModel = m.models.find((x) => x.is_active)?.name ?? state.activeModel;
      state.history = m.history.map((h) => ({ at: h.at.slice(5, 16), from: h.from ?? '—', to: h.to, by: h.by ?? '', result: h.status === 'ok' ? `สำเร็จ · ${(h.switch_ms / 1000).toFixed(1)} วิ` : `ไม่สำเร็จ · ${h.error}`, tone: h.status === 'ok' ? 'success' : 'danger' }));
    });
    if (!A.models) return aShell('models', '<p class="muted">กำลังโหลด…</p>');
    const inf = A.inference;
    const note = inf ? `<div class="banner ${inf.ok ? 'warn' : 'err'}" style="margin:0 0 16px;${inf.ok ? 'background:var(--success-subtle);border-color:rgba(22,163,74,.35)' : ''}">${ic(inf.ok ? 'check' : 'alert', 20)}<span class="t-cap">inference ${inf.mode} · ${inf.ok ? `${esc(inf.model ?? '')} บน ${esc(inf.device ?? '')} · ${inf.nc} คลาส` : `เชื่อมต่อไม่ได้ (${esc(inf.last_error?.code ?? '')}) · npm run inference`}</span></div>` : '';
    return viewModelsProto().replace('<div class="grid-side">', `${note}<div class="grid-side">`);
  }
  let viewModelsProto = null;

  async function liveSwitch() {
    const { name } = state.modelModal;
    state.modelModal = null; state.modelProgress = { name, pct: 5 }; render();
    const timer = setInterval(() => { const p = state.modelProgress; if (p && p.pct < 90) { p.pct += 5; if (currentPath() === '/a/models') render(); } }, 250);
    try {
      const r = await API.post(`/api/admin/models/${encodeURIComponent(name)}/activate`);
      state.modelProgress.pct = 100;
      toast('success', `สลับเป็น ${name.split('-')[0]} สำเร็จ · ${(r.switch_ms / 1000).toFixed(1)} วิ · ตรวจจับได้ ${r.detectable ?? '—'} สินค้า`);
    } catch (err) {
      toast('danger', `${err.message}${err.body?.detail ? ` (${err.body.detail.slice(0, 80)})` : ''}`);
    }
    clearInterval(timer);
    state.modelProgress = null; A.models = null;
    Live.refreshMeta?.();
    render();
  }

  // ------------------------------------------------------------ sessions
  /** cart_events.note in words (REMOVE notes carry the exit evidence as JSON) */
  function noteText(note) {
    if (!note.startsWith('exit evidence:')) return note;
    try {
      const ev = JSON.parse(note.slice('exit evidence:'.length));
      return `หยิบออกทางขอบ ROI${ev.outside ? ' (เห็นนอก ROI)' : ''} · หายไป ${ev.missing_frames} เฟรม`;
    } catch { return 'มีหลักฐานการหยิบออก'; }
  }

  function viewSessions() {
    if (!A.sessions) once('sessions', async () => { A.sessions = (await API.get('/api/admin/sessions?limit=100')).sessions; });
    const list = A.sessions ?? [];
    if (!state.selSessionLive && list.length) state.selSessionLive = list[0].session_id;
    const sel = list.find((x) => x.session_id === state.selSessionLive);
    const det = sel ? A.sessionDetail[sel.session_id] : null;
    if (sel && !det) once(`sess-${sel.session_id}`, async () => { A.sessionDetail[sel.session_id] = await API.get(`/api/admin/sessions/${sel.session_id}`); });
    const ST_TONE = { active: 'primary', checked_out: 'success', abandoned: 'neutral', timeout: 'warning' };
    const rows = list.map((r) => `<tr class="click ${r.session_id === state.selSessionLive ? 'sel' : ''}" data-act="sel-session-live" data-id="${r.session_id}" tabindex="0"><td class="t-strong">${shortId(r.session_id)}</td><td>${r.cart}</td><td>${hhmm(r.started_at_ms)}</td><td>${mmss(r.duration_ms)}</td><td class="r num">${r.item_count ?? 0}</td><td class="r num">${baht(r.total_auto ?? 0)}</td>
      <td class="r num" style="color:${r.total_checkout != null && Math.abs(r.total_checkout - (r.total_auto ?? 0)) >= 0.01 ? 'var(--danger)' : 'inherit'}">${r.total_checkout == null ? '—' : baht(r.total_checkout)}</td><td>${badge(ST_TONE[r.status], r.status)}</td></tr>`).join('');
    const tone = (t) => ({ ADD: 'success', REMOVE: 'danger', CORRECTION: 'warning', CHECKOUT: 'primary' }[t] || 'neutral');
    const dotc = (t) => ({ ADD: 'var(--success)', REMOVE: 'var(--danger)', CORRECTION: 'var(--warning)', CHECKOUT: 'var(--primary)', REASON: 'var(--primary)' }[t] || 'var(--text-2)');
    // events and reasons on one time line (brief 7.6: reason rows inserted by time)
    const evs = [
      ...(det?.events ?? []).map((e) => ({ t: e.occurred_at_ms, type: e.event_type, cls: e.class_name, img: e.image_url,
        txt: e.class_name ? `${e.name_th} ${e.qty_delta > 0 ? '+' : '−'}${Math.abs(e.qty_delta)}` : e.note ?? e.event_type,
        meta: e.class_name ? `${e.confidence_avg != null ? `conf ${e.confidence_avg.toFixed(2)} · ` : ''}${e.source}${e.note ? ` · ${noteText(e.note)}` : ''}` : `source: ${e.source}` })),
      ...(det?.reasons ?? []).filter((r) => r.status !== 'voided').map((r) => ({ t: r.decided_at_ms, type: 'REASON', reason: r,
        txt: `${r.label_th}: ${r.from_name ?? ''}${r.to_name && r.to_class !== r.from_class ? ` → ${r.to_name}` : ''}`,
        meta: `${r.status === 'pending' ? 'รอดูสินค้าที่หยิบแทน · ' : ''}${r.dwell_ms != null ? `อยู่ในรถเข็น ${Math.round(r.dwell_ms / 1000)} วิ` : ''}${r.price_delta != null ? ` · ส่วนต่าง ${baht(r.price_delta)}` : ''}` })),
    ].sort((a, b) => a.t - b.t);
    const tl = evs.map((e, i) => `<div class="tl-row"><span class="t-cap-strong muted" style="padding-top:4px">${hhmmss(e.t)}</span>
      <div class="tl-rail"><span class="dot" style="background:${dotc(e.type)}"></span>${i < evs.length - 1 ? '<span class="line"></span>' : ''}</div>
      <div class="tl-body"><div class="grow col gap-4"><div class="row">${e.reason ? badge(e.reason.tone, e.reason.reason_code) : badge(tone(e.type), e.type)}<span class="t-strong">${esc(e.txt)}</span></div><span class="t-cap muted">${esc(e.meta)}</span></div>
        ${e.img ? `<img src="${esc(e.img)}" alt="ภาพ ณ เหตุการณ์">` : e.cls ? pimg(e.cls, 56, 8) : ''}</div></div>`).join('');
    const count = (t) => (det?.events ?? []).filter((e) => e.event_type === t).length;
    return aShell('sessions', `
      ${pageTitle('Sessions', `shopping_sessions · ${list.length} session ล่าสุด · เลือกแถวเพื่อดู timeline`)}
      <div class="grid-2" style="grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);align-items:start">
        <div class="card card-pad">${cardHead('รายการ session', 'ยอดระบบ (total_auto) เทียบยอดจริงจาก POS (total_checkout) · ตัวแดง = ไม่ตรง')}
          <div class="table-wrap"><table class="table"><thead><tr><th>Session</th><th>รถเข็น</th><th>เริ่ม</th><th>ระยะเวลา</th><th class="r">ชิ้น</th><th class="r">ยอดระบบ</th><th class="r">ยอด POS</th><th>สถานะ</th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="muted">ยังไม่มี session</td></tr>'}</tbody></table></div></div>
        <div class="card card-pad">${sel ? `${cardHead(`Timeline · ${shortId(sel.session_id)}`, `รถเข็น ${sel.cart} · เริ่ม ${hhmm(sel.started_at_ms)} · cart_events + change_reasons + frames.image_path`, badge(ST_TONE[sel.status], sel.status))}
          <div class="row gap-8" style="margin-bottom:16px">${[['ADD', count('ADD')], ['REMOVE', count('REMOVE')], ['CORRECTION', count('CORRECTION')], ['ยอด', baht(sel.total_auto ?? 0)]].map(([l, v]) => `<div class="col grow" style="padding:8px 12px;border-radius:8px;background:var(--bg)"><span class="t-strong num">${v}</span><span class="t-cap muted">${l}</span></div>`).join('')}</div>
          ${det ? tl : '<span class="muted">กำลังโหลด…</span>'}` : '<span class="muted">เลือก session</span>'}</div>
      </div>`);
  }
  ACT['sel-session-live'] = (el) => { state.selSessionLive = el.dataset.id; render(); };

  // ------------------------------------------------------------ latency
  const WIN = ['1h', '24h', '7d'];
  function viewLatency() {
    const w = WIN[state.latWin];
    const L = A.latency[w];
    if (!L) once(`lat-${w}`, async () => { A.latency[w] = await API.get(`/api/admin/latency?window=${w}`); });
    if (!L) return aShell('latency', '<p class="muted">กำลังโหลด…</p>');
    const st = L.stages;
    const e2e = st.e2e_ms.n ? st.e2e_ms : st.server_total_ms;
    const src = st.e2e_ms.n ? 'E2E จากมือถือ' : 'server (ยังไม่มี E2E จากมือถือ)';
    const f0 = (v) => (v == null ? '—' : Math.round(v));
    const kpi = (l, v, b, tone, note) => `<div class="card kpi"><div class="row"><span class="t-label muted grow">${l}</span><span class="tile">${ic('latency', 18)}</span></div><span class="t-h1 num">${v}</span><div class="row">${badge(tone, b)}<span class="t-cap muted">${note}</span></div></div>`;
    const dropPct = L.frames ? (L.dropped / L.frames) * 100 : 0;
    const rowsDef = [['Queue (รอคิว)', st.queue_ms], ['Inference (เรียก service)', st.infer_call_ms], ['· โมเดลเอง (infer_ms)', st.infer_model_ms], ['Tracker', st.tracker_ms], ['DB write (SQLite)', st.db_ms], ['Push (WebSocket)', st.push_ms], ['Network (RTT มือถือ)', st.rtt_ms]];
    const maxP95 = Math.max(1, ...rowsDef.map(([, s]) => s.p95 ?? 0), e2e.p95 ?? 0);
    const rows = rowsDef.map(([l, s], i) => `<tr><td>${l}</td><td class="r num">${f0(s.p50)}</td><td class="r num t-strong">${f0(s.p95)}</td><td class="r num">${f0(s.p99)}</td>
      <td><div class="bar-track" style="width:120px"><span style="width:${Math.max(2, ((s.p95 ?? 0) / maxP95) * 100)}%;background:${i === 1 ? 'var(--primary)' : 'var(--success)'}"></span></div></td></tr>`).join('')
      + `<tr><td class="t-strong">End-to-end</td><td class="r num t-strong">${f0(e2e.p50)}</td><td class="r num t-strong" style="color:${e2e.p95 > 300 ? 'var(--danger)' : 'inherit'}">${f0(e2e.p95)}</td><td class="r num t-strong">${f0(e2e.p99)}</td><td><div class="bar-track" style="width:120px"><span style="width:100%;background:var(--text)"></span></div></td></tr>`;
    const vals = L.series.map((x) => x.p95 ?? 0);
    const top = Math.max(100, Math.ceil(Math.max(...vals, 300) / 100) * 100);
    const peak = vals.indexOf(Math.max(...vals));
    const xl = { '1h': ['−60', '−50', '−40', '−30', '−20', '−10', 'ตอนนี้'], '24h': ['−24ชม', '−20', '−16', '−12', '−8', '−4', 'ตอนนี้'], '7d': ['−7วัน', '−6', '−5', '−4', '−3', '−2', 'ตอนนี้'] }[w];
    const seg5 = [['Network', st.rtt_ms.p50, 'var(--primary)'], ['Inference', st.infer_call_ms.p50, 'var(--success)'], ['Queue', st.queue_ms.p50, 'var(--warning)'], ['DB', st.db_ms.p50, 'var(--danger)'], ['Tracker', st.tracker_ms.p50, 'var(--text-2)'], ['Push', st.push_ms.p50, 'var(--border)']].filter(([, v]) => v != null);
    const sum = seg5.reduce((a, [, v]) => a + v, 0) || 1;
    return aShell('latency', `
      ${pageTitle('Latency monitor', `v_frame_latency · /api/admin/latency · ${L.carts ?? 0} รถเข็น · ${L.frames.toLocaleString('en-US')} เฟรม`, seg('lat-win', ['1 ชม.', '24 ชม.', '7 วัน'], state.latWin) + badge('primary', 'เกณฑ์ p95 ≤ 300 ms'))}
      <div class="kpis">
        ${kpi('End-to-end p50', `${f0(e2e.p50)} ms`, src, 'neutral', `n = ${e2e.n}`)}
        ${kpi('End-to-end p95', `${f0(e2e.p95)} ms`, e2e.p95 == null ? 'ยังไม่มีข้อมูล' : e2e.p95 <= 300 ? 'ผ่านเกณฑ์' : 'เกินเกณฑ์', e2e.p95 == null ? 'neutral' : e2e.p95 <= 300 ? 'success' : 'danger', 'เกณฑ์ 300 ms')}
        ${kpi('End-to-end p99', `${f0(e2e.p99)} ms`, src, 'neutral', 'ช่วงเลวร้ายสุด')}
        ${kpi('เฟรมที่ถูกทิ้ง', `${dropPct.toFixed(1)}%`, `คิว > ${2} เฟรม`, dropPct < 5 ? 'success' : 'warning', `${L.dropped} / ${L.frames} · error ${L.errors}`)}
      </div>
      <div class="grid-2" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
        <div class="card card-pad">${cardHead('End-to-end p95 ตามเวลา', `${['1 ชม.', '24 ชม.', '7 วัน'][state.latWin]} · 24 ช่วง · ${L.series.some((x) => x.source === 'e2e') ? 'E2E มือถือ' : 'server'}`, badge(Math.max(...vals) > 300 ? 'warning' : 'success', Math.max(...vals) > 300 ? 'มีช่วงเกินเกณฑ์' : 'อยู่ในเกณฑ์'))}
          ${lineChart({ vals, min: 0, max: top, yl: [top, top * 0.75, top / 2, top / 4].map((v) => String(Math.round(v))), xl, peak, peakLabel: `p95 ${Math.round(vals[peak] ?? 0)} ms`, threshold: 300, thLabel: 'เกณฑ์ 300 ms', label: 'latency p95 ตามเวลา' })}</div>
        <div class="card card-pad">${cardHead('แยกตามช่วง (ms)', 'queue → infer → tracker → db → push · network = RTT จาก device')}
          <div class="table-wrap"><table class="table"><thead><tr><th>ช่วง</th><th class="r">p50</th><th class="r">p95</th><th class="r">p99</th><th>สัดส่วน p95</th></tr></thead><tbody>${rows}</tbody></table></div></div>
      </div>
      <div class="card card-pad">${cardHead(`องค์ประกอบ latency p50 (${f0(sum)} ms)`, seg5.length ? `ส่วนที่ใหญ่ที่สุด: ${seg5.slice().sort((a, b) => b[1] - a[1])[0][0]}` : 'ยังไม่มีข้อมูล')}
        <div style="display:flex;gap:2px;height:16px;border-radius:4px;overflow:hidden">${seg5.map(([l, v, c]) => `<span title="${l} ${f0(v)} ms" style="flex:${Math.max(v / sum, 0.01)};background:${c}"></span>`).join('')}</div>
        <div class="row wrap gap-16" style="margin-top:12px">${seg5.map(([l, v, c]) => `<span class="row gap-4 t-cap"><span style="width:10px;height:10px;border-radius:3px;background:${c}"></span>${l} ${f0(v)} ms</span>`).join('')}</div></div>`);
  }

  // ------------------------------------------------------------ install (live mode only)
  if (!API.mock) {
    viewModelsProto = VIEWS['/a/models'];
    Object.assign(VIEWS, { '/a/dashboard': viewDashboard, '/a/live': viewLive, '/a/models': viewModels, '/a/sessions': viewSessions, '/a/latency': viewLatency });
    ACT['model-confirm'] = () => liveSwitch();
    ACT['range'] = (el) => { state.range = +el.dataset.v; render(); };
    ACT['lat-win'] = (el) => { state.latWin = +el.dataset.v; render(); };
    // "อัปเดต X วิ" on the live grid
    setInterval(() => {
      document.querySelectorAll('[data-upd-live]').forEach((el) => {
        const t = A.liveInfo[el.dataset.updLive]?.t;
        if (t) el.textContent = `อัปเดต ${Math.max(0, Math.round((Date.now() - t) / 1000))} วิ`;
      });
      // live -> disconnected after STALE_MS without a frame (phone tab closed, screen off, paused)
      const p = currentPath();
      const shown = p === '/a/live' ? A.carts ?? [] : p.startsWith('/a/live/') ? [A.cartDetail[p.slice(8)]].filter(Boolean) : [];
      let changed = false;
      for (const c of shown) {
        const live = isLive(c);
        if (!live && A.thumbs[c.cart]) dropThumb(c.cart);
        if (A.rendered[c.cart] !== undefined && A.rendered[c.cart] !== live) changed = true;
      }
      if (changed && !A.devModal) render();
    }, 1000);
    setInterval(() => { if (state.user) loadAlerts().then(() => { if (currentPath().startsWith('/a/')) render(); }).catch(() => {}); }, 30_000);
  }
  return { viewLiveDetail, loadAlerts };
})();
