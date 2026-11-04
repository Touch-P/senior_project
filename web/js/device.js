'use strict';
/* Smart Cart — phone as the cart camera (brief section 9).
 * URL: /device.html?cart=A-07&fps=4&token=…   (QR from Admin > Live "เพิ่ม device (กล้องมือถือ)" or npm run device-link)
 * The camera opens only when "เริ่มส่งภาพ" is pressed (iOS Safari needs a user gesture for getUserMedia), then
 * streams JPEG frames over /ws/device/{cart}?token=… as
 *   JSON header {seq, t_capture, w, h} + "\n" + JPEG bytes   (binary, never base64)
 * sends the next frame only after the previous ack (no queue builds up), skips frames while
 * ws.bufferedAmount > 512 KB, reconnects with backoff 0.5 s -> 10 s, measures
 *   RTT = send -> ack (frame_seq), E2E = send -> processed   with this phone's performance.now() only,
 * and posts the measurements with navigator.sendBeacon('/api/metrics').
 * "หยุด" closes the socket and turns the camera off. Admins (logged in on this phone) can drag the 4 ROI corners.
 */
(() => {
  const APP_VERSION = 'device-1.1.0';
  const MAX_BUFFERED = 512 * 1024;           // skip a frame while this much is still queued in the socket
  const BACKOFF_MIN_MS = 500, BACKOFF_MAX_MS = 10_000;
  // asked as "ideal" only (see openCamera); 1280×960 = 4:3 like the training photos, but any ratio the camera gives is kept
  const CAMERA_CONSTRAINTS = { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } };
  const ICON = {
    cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
    wifioff: '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="M2 2l20 20"/>',
    live: '<path d="M16 13l5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    alert: '<path d="M21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
    play: '<path d="M6 4l14 8-14 8z"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  };
  const ic = (n, s = 20) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pill = (st, text) => ({
    connected: `<span class="pill pill-connected"><span class="dot"></span>${text ?? 'เชื่อมต่อแล้ว · ส่งภาพ'}</span>`,
    updating: `<span class="pill pill-updating"><span class="dot"></span>${text ?? 'กำลังเชื่อมต่อ…'}</span>`,
    disconnected: `<span class="pill pill-disconnected">${ic('wifioff', 14)}${text ?? 'ขาดการเชื่อมต่อ'}</span>`,
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

  // ------------------------------------------------------------ settings (matrix of instruction part 3)
  const OPTIONS = { fps: [2, 3, 4, 5], size: [480, 640], quality: [0.5, 0.7, 0.9] };
  const DEFAULTS = { fps: 4, size: 640, quality: 0.7 };
  const store = {
    get() { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('sc-device') || '{}') }; } catch { return { ...DEFAULTS }; } },
    set(v) { try { localStorage.setItem('sc-device', JSON.stringify(v)); } catch { /* private mode */ } },
  };

  const params = new URLSearchParams(location.search);
  const urlFps = Number(params.get('fps'));
  const CART_RE = /^[A-Z]-\d{2}$/;
  const S = {
    cart: (params.get('cart') || '').toUpperCase(),
    token: params.get('token') || '',
    tokenFromUrl: Boolean(params.get('token')),
    settings: { ...store.get(), ...(OPTIONS.fps.includes(urlFps) ? { fps: urlFps } : {}) },
    running: false,             // "เริ่มส่งภาพ" pressed (camera on, socket wanted) until "หยุด"
    conn: 'disconnected',       // connected | updating | disconnected
    hidden: document.hidden,
    sessionActive: null,
    roi: [[0.2, 0.14], [0.8, 0.14], [0.96, 0.99], [0.04, 0.99]],
    editRoi: null,              // copy of the polygon while an admin edits it
    isAdmin: false,
    error: null,
    stats: { sent: 0, lost: 0, rtt: null, e2e: null, fps: 0 },
    camera: '',
  };

  // ------------------------------------------------------------ render (same components as the prototype)
  const seg = (key, values, label) => `<div class="col gap-4"><span class="t-cap dev-label">${label}</span>
    <div class="seg dev-seg" role="radiogroup" aria-label="${label}">${values.map((v) => `<button role="radio" aria-checked="${S.settings[key] === v}" class="${S.settings[key] === v ? 'on' : ''}" data-set="${key}" data-v="${v}">${key === 'size' ? v + ' px' : key === 'fps' ? v + ' fps' : v}</button>`).join('')}</div></div>`;

  function roiSvg() {
    const poly = S.editRoi ?? S.roi;
    const pts = poly.map(([x, y]) => `${x * 100},${y * 100}`).join(' ');
    const handles = S.editRoi ? poly.map(([x, y], i) => `<button class="roi-handle" data-corner="${i}" style="left:${x * 100}%;top:${y * 100}%" aria-label="มุม ROI ที่ ${i + 1}"></button>`).join('') : '';
    return `<svg class="roi" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon points="${pts}" fill="${S.editRoi ? 'rgba(245,158,11,.12)' : 'none'}" stroke="#F59E0B" stroke-width="2" stroke-dasharray="8 6" vector-effect="non-scaling-stroke"/></svg>${handles}`;
  }

  // The page is mounted once; render() only rewrites the parts around the <video>, so the camera preview
  // never restarts (a new <video> would show black frames and make grab() return nothing).
  function mount() {
    $('#app').innerHTML = `<div class="c-stage device-stage"><div class="phone dark device">
      <div class="c-top" id="dev-head"></div>
      <div id="dev-banner"></div>
      <div class="dev-preview" id="preview"><video id="video" playsinline muted autoplay></video><div class="dev-overlay" id="dev-overlay"></div></div>
      <div class="dev-stats" id="dev-stats"></div>
      <div class="c-body"><div class="dev-controls" id="dev-controls"></div></div>
    </div></div>`;
  }

  function render() {
    const st = S.stats;
    const f = (v, unit = ' ms') => (v == null ? '–' : Math.round(v) + unit);
    const live = S.running && S.conn === 'connected' && !S.hidden && !S.editRoi;
    const status = S.error ? pill('disconnected', 'ใช้งานไม่ได้')
      : !S.running ? pill('disconnected', 'ยังไม่ได้ส่งภาพ')
      : S.conn === 'connected' && !live ? pill('updating', 'หยุดส่งชั่วคราว')
      : pill(S.conn);
    $('#dev-head').innerHTML = `<div class="logo-mark dev-logo">${ic('cart', 20)}</div>
      <div class="col grow"><span class="t-h3">กล้องรถเข็น ${esc(S.cart || '—')}</span><span class="t-cap dev-label">${esc(S.camera || 'กล้องหลัง')}</span></div>${status}`;
    $('#dev-banner').innerHTML = S.error
      ? `<div class="banner err">${ic('alert', 20)}<div class="col gap-4"><span class="t-label title">${esc(S.error.title)}</span><span class="t-cap">${esc(S.error.detail)}</span></div></div>`
      : S.sessionActive === false
        ? `<div class="banner warn">${ic('info', 20)}<div class="col gap-4"><span class="t-label title">ยังไม่มีลูกค้าใช้รถเข็นคันนี้</span><span class="t-cap">ส่งภาพได้ แต่ระบบยังไม่ตรวจนับและไม่บันทึกจนกว่าลูกค้าจะสแกน QR</span></div></div>`
        : '';
    $('#preview').classList.toggle('editing', Boolean(S.editRoi));
    const idle = !S.running ? `<div class="cam-off">${ic('live', 28)}<span>กด "เริ่มส่งภาพ" เพื่อเปิดกล้องหลัง</span></div>` : '';
    $('#dev-overlay').innerHTML = `${idle}${roiSvg()}<div class="cam-tag"><span class="live" ${live ? '' : 'style="background:#64748B;animation:none"'}></span>${S.conn === 'connected' ? 'LIVE' : 'OFFLINE'} · ${esc(S.cart)}</div>`;
    $('#dev-stats').innerHTML = `
        <div class="col"><span class="t-cap dev-label">fps จริง</span><span class="t-strong num">${st.fps.toFixed(1)}</span></div>
        <div class="col"><span class="t-cap dev-label">RTT ส่ง→ack</span><span class="t-strong num">${f(st.rtt)}</span></div>
        <div class="col"><span class="t-cap dev-label">E2E ส่ง→ผล</span><span class="t-strong num">${f(st.e2e)}</span></div>
        <div class="col"><span class="t-cap dev-label">ส่ง / ไม่ได้ผล</span><span class="t-strong num">${st.sent} / ${st.lost}</span></div>`;
    $('#dev-controls').innerHTML = `
        ${S.editRoi ? `<p class="t-cap" style="margin:0">ลากมุมสีเหลืองทั้ง 4 ให้ล้อมพื้นตะกร้า แล้วกดบันทึก มีผลกับเฟรมถัดไปทันที</p>
          <div class="row gap-8"><button class="btn btn-secondary btn-m grow" data-act="roi-cancel">ยกเลิก</button><button class="btn btn-primary btn-m grow" data-act="roi-save">${ic('check', 16)}บันทึก ROI</button></div>`
        : `${S.running ? '' : startFields()}
          ${seg('fps', OPTIONS.fps, 'อัตราเฟรม')}${seg('size', OPTIONS.size, 'ด้านยาวของภาพ')}${seg('quality', OPTIONS.quality, 'คุณภาพ JPEG')}
          <div class="row gap-8">
            ${S.running ? `<button class="btn btn-danger btn-l grow" data-act="stop">${ic('stop', 18)}หยุด</button>`
              : `<button class="btn btn-primary btn-l grow" data-act="start">${ic('play', 18)}เริ่มส่งภาพ</button>`}
            ${S.isAdmin && S.running ? `<button class="btn btn-secondary btn-l" data-act="roi-edit">${ic('edit', 16)}ตั้ง ROI</button>` : ''}
          </div>`}
        <p class="t-cap dev-label center" style="margin:0">กล้องมองเฉพาะภายในตะกร้า ระบบไม่บันทึกใบหน้า · เก็บภาพเฉพาะเฟรมที่เกิดการหยิบเข้า–ออก</p>`;
  }

  /** cart + token before starting (filled from the QR link; the token field only appears when the link had none) */
  function startFields() {
    return `<div class="field"><label for="dev-cart" class="dev-label">รถเข็น</label>
        <div class="input"><input id="dev-cart" value="${esc(S.cart)}" placeholder="A-07" maxlength="4" autocapitalize="characters" autocomplete="off" spellcheck="false"></div></div>
      ${S.tokenFromUrl ? '' : `<div class="field"><label for="dev-token" class="dev-label">token ของกล้อง (จาก admin)</label>
        <div class="input"><input id="dev-token" value="${esc(S.token)}" placeholder="สแกน QR จาก Admin › Live แทนการพิมพ์" autocomplete="off" spellcheck="false"></div></div>`}`;
  }

  // ------------------------------------------------------------ camera
  let stream = null;
  const httpsError = () => ({ title: 'ต้องเปิดผ่าน HTTPS', detail: `browser เปิดกล้องได้เฉพาะหน้า https:// (ตอนนี้เป็น ${location.protocol}//) — สแกน QR จาก Admin › Live "เพิ่ม device (กล้องมือถือ)" หรือใช้ https://<IP เครื่อง>:8443 / https://xxxx.trycloudflare.com ตาม docs/phone-camera.md` });
  /** Thai message with what to do, for each way getUserMedia can fail */
  function cameraError(err) {
    const n = err?.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return { title: 'ไม่ได้รับอนุญาตให้ใช้กล้อง',
      detail: 'Android (Chrome): แตะไอคอนหน้าแถบที่อยู่ → สิทธิ์ → กล้อง → อนุญาต · iPhone: การตั้งค่า → Safari → กล้อง → อนุญาต (หรือแตะ "aA" → การตั้งค่าเว็บไซต์) แล้วกด "เริ่มส่งภาพ" อีกครั้ง' };
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return { title: 'ไม่พบกล้องหลัง', detail: 'เครื่องนี้ไม่มีกล้องที่ browser ใช้ได้ ลองใช้มือถือเครื่องอื่น' };
    if (n === 'NotReadableError' || n === 'AbortError') return { title: 'กล้องถูกใช้งานอยู่', detail: 'ปิดแอปอื่นที่ใช้กล้อง (แอปกล้อง, video call, แท็บอื่น) แล้วกด "เริ่มส่งภาพ" อีกครั้ง' };
    return { title: 'เปิดกล้องไม่ได้', detail: `${n ?? 'Error'}: ${err?.message ?? ''} · ลองรีเฟรชหน้านี้ หรือเปิดด้วย Chrome / Safari เวอร์ชันล่าสุด` };
  }
  /** Must be the first await of the click handler: iOS Safari only opens the camera from a user gesture. */
  async function openCamera() {
    if (!window.isSecureContext) { S.error = httpsError(); return false; }
    if (!navigator.mediaDevices?.getUserMedia) {
      S.error = { title: 'browser นี้เปิดกล้องไม่ได้', detail: 'เปิดลิงก์ด้วย Chrome (Android) หรือ Safari (iPhone) เวอร์ชันล่าสุด ไม่ใช่ browser ในแอป LINE / Facebook' };
      return false;
    }
    try {
      // ideal values only: no aspectRatio / exact sizes, which make some browsers crop the sensor image.
      // Whatever the camera really delivers (video.videoWidth × videoHeight) is what gets sent.
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: CAMERA_CONSTRAINTS });
      const track = stream.getVideoTracks()[0];
      const v = $('#video');
      // the preview box takes the real ratio of the video (and again when the phone rotates: 3:4 <-> 4:3),
      // so the ROI drawn on it matches the frame sent; object-fit: contain never stretches or crops
      const syncRatio = () => {
        if (!v.videoWidth) return;
        $('#preview').style.setProperty('--ar', `${v.videoWidth} / ${v.videoHeight}`);
        const s = track.getSettings?.() ?? {};
        S.camera = `${track.label || 'camera'} ${v.videoWidth}×${v.videoHeight}${s.frameRate ? ` @${Math.round(s.frameRate)}` : ''}`.trim();
      };
      v.onloadedmetadata = syncRatio;
      v.onresize = syncRatio;
      v.srcObject = stream;
      await v.play().catch(() => {});
      syncRatio();
      return true;
    } catch (err) {
      S.error = cameraError(err);
      return false;
    }
  }
  function closeCamera() {
    for (const t of stream?.getTracks() ?? []) t.stop();
    stream = null;
    const v = $('#video');
    if (v) v.srcObject = null;
    S.camera = '';
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  /** JPEG of the current video frame: long side = settings.size, short side from the real ratio (never a fixed 640×480). */
  function grab() {
    const v = $('#video');
    const size = v && SCFrame.fitLongSide(v.videoWidth, v.videoHeight, S.settings.size);
    if (!size) return null;
    // a new size (first frame, or the phone rotated) resizes the canvas; same size keeps it (no realloc per frame)
    if (canvas.width !== size.width || canvas.height !== size.height) { canvas.width = size.width; canvas.height = size.height; }
    // PDPA: crop the basket ROI on the phone HERE (instruction 4.6 / docs/roadmap.md). Draw only the bounding box
    // of S.roi (normalized corners) with ctx.drawImage(v, sx, sy, sw, sh, 0, 0, cw, ch) and put that rectangle in
    // the header (e.g. {crop: [x0, y0, x1, y1]}) so the server can map boxes and the ROI back to the full frame.
    // Then faces / other shoppers outside the basket never leave the phone. Off for now: the server still expects
    // full frames, so postprocess/geometry must learn the crop offset first.
    ctx.drawImage(v, 0, 0, size.width, size.height); // whole frame, both axes scaled by the same factor
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', S.settings.quality));
  }

  // ------------------------------------------------------------ connection
  let ws = null, seq = 0, retry = 0, opened = 0, everOpened = false, waitingAck = null, reconnectTimer = null;
  const pending = new Map();   // seq -> { t0, rtt }
  const metrics = [];
  const sentTimes = [];

  function connect() {
    if (!S.cart || !S.token) {
      S.error = { title: 'ลิงก์ไม่ครบ', detail: 'เปิดหน้านี้จาก QR ที่ admin สร้างให้รถเข็น (มี cart และ token)' };
      return render();
    }
    if (!S.running) return;
    S.conn = 'updating';
    render();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/device/${encodeURIComponent(S.cart)}?token=${encodeURIComponent(S.token)}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      retry = 0; everOpened = true; opened = Date.now();
      S.conn = 'connected';
      ws.send(JSON.stringify({ type: 'hello', camera_desc: `${S.camera} · ${navigator.userAgent}`.slice(0, 200), app_version: APP_VERSION,
        settings: S.settings }));
      render();
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const msg = JSON.parse(e.data);
      const now = performance.now();
      if (msg.type === 'config') { S.roi = msg.roi_polygon; S.sessionActive = msg.session_active; render(); }
      else if (msg.type === 'roi_changed') { S.roi = msg.roi_polygon; if (!S.editRoi) render(); }
      else if (msg.type === 'session') { S.sessionActive = msg.active; render(); }
      else if (msg.type === 'ack') {
        const aseq = msg.frame_seq ?? msg.seq;
        const p = pending.get(aseq);
        if (p) { p.rtt = now - p.t0; S.stats.rtt = p.rtt; }
        if (waitingAck === aseq) waitingAck = null;
      } else if (msg.type === 'processed') {
        const p = pending.get(msg.seq);
        if (!p) return;
        pending.delete(msg.seq);
        if (msg.idle) { if (S.sessionActive !== false) { S.sessionActive = false; render(); } return; }
        if (S.sessionActive === false) { S.sessionActive = true; render(); }
        if (msg.error) { S.stats.lost++; return; }
        S.stats.e2e = now - p.t0;
        metrics.push({ seq: msg.seq, rtt_ms: p.rtt == null ? null : Math.round(p.rtt * 10) / 10, e2e_ms: Math.round(S.stats.e2e * 10) / 10 });
      }
    };
    ws.onclose = (e) => {
      S.conn = 'disconnected';
      waitingAck = null;
      pending.clear();
      if (!S.running) return render(); // "หยุด" pressed: no reconnect
      if (e.code === 4000) {
        S.error = { title: 'มีมือถืออีกเครื่องต่อเป็นกล้องของรถเข็นนี้แทนแล้ว', detail: 'รีเฟรชหน้านี้ถ้าต้องการใช้เครื่องนี้' };
        return render();
      }
      if (!everOpened && retry >= 3) {
        S.error = { title: 'เชื่อมต่อไม่ได้', detail: 'token อาจหมดอายุ (admin สร้าง QR ใหม่แล้ว) หรือ server ไม่ได้รัน — ขอ QR ใหม่จาก admin' };
      }
      render();
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** retry); // 0.5, 1, 2, 4, 8, 10, 10 … s
      retry++;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, delay);
    };
  }

  // ------------------------------------------------------------ start / stop
  async function start() {
    const cartIn = $('#dev-cart'), tokenIn = $('#dev-token');
    const cart = (cartIn?.value ?? S.cart).trim().toUpperCase();
    const token = (tokenIn?.value ?? S.token).trim();
    if (!CART_RE.test(cart)) { toast('danger', 'รหัสรถเข็นต้องเป็นรูปแบบ A-07'); cartIn?.focus(); return; }
    if (!token) { toast('danger', 'ยังไม่มี token: สแกน QR จาก Admin › Live "เพิ่ม device (กล้องมือถือ)"'); tokenIn?.focus(); return; }
    if (cart !== S.cart && S.tokenFromUrl) toast('warning', `token ในลิงก์ออกให้รถเข็น ${S.cart} ถ้าเชื่อมต่อไม่ได้ให้ขอ QR ของ ${cart}`);
    S.cart = cart; S.token = token; S.error = null;
    const ok = await openCamera();   // first await of the click: keeps the user gesture for iOS
    if (!ok) return render();
    S.running = true;
    retry = 0; everOpened = false;
    // a reload keeps cart/fps/token (the link is this phone's credential, same as the QR it came from)
    const q = new URLSearchParams({ cart: S.cart, fps: String(S.settings.fps), token: S.token });
    history.replaceState(null, '', `${location.pathname}?${q}`);
    connect();
    startLoop();
    lockScreen();
    checkAdmin();
  }
  function stop() {
    S.running = false;
    S.editRoi = null;
    clearTimeout(reconnectTimer);
    clearInterval(loopTimer);
    ws?.close(1000, 'stopped on the phone');
    ws = null;
    S.conn = 'disconnected';
    closeCamera();
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    S.stats.fps = 0;
    render();
  }

  // capture loop: at most `fps` frames per second, next frame only after the ack of the previous one
  let loopTimer = null;
  function startLoop() {
    clearInterval(loopTimer);
    loopTimer = setInterval(tick, 1000 / S.settings.fps);
  }
  async function tick() {
    const now = performance.now();
    if (!S.running || !ws || ws.readyState !== WebSocket.OPEN || S.hidden || S.editRoi) return;
    if (waitingAck !== null) {
      if (now - pending.get(waitingAck)?.t0 < 2000) return;
      waitingAck = null; // ack lost: give up on that one
    }
    if (ws.bufferedAmount > MAX_BUFFERED) return; // slow uplink: drop this frame instead of queueing
    for (const [k, p] of pending) if (now - p.t0 > 5000) { pending.delete(k); S.stats.lost++; }
    const blob = await grab();
    if (!blob) return;
    seq++;
    const header = new TextEncoder().encode(JSON.stringify({ seq, t_capture: Date.now(), w: canvas.width, h: canvas.height }) + '\n');
    const body = new Uint8Array(await blob.arrayBuffer());
    const msg = new Uint8Array(header.length + body.length);
    msg.set(header, 0);
    msg.set(body, header.length);
    pending.set(seq, { t0: performance.now(), rtt: null });
    waitingAck = seq;
    ws.send(msg);
    S.stats.sent++;
    sentTimes.push(Date.now());
  }

  setInterval(() => {
    const now = Date.now();
    while (sentTimes.length && now - sentTimes[0] > 5000) sentTimes.shift();
    S.stats.fps = opened ? sentTimes.length / Math.min(5, Math.max(1, (now - opened) / 1000)) : 0;
    if (metrics.length) {
      const body = JSON.stringify({ cart: S.cart, token: S.token, items: metrics.splice(0, 500) });
      if (!navigator.sendBeacon?.('/api/metrics', body)) fetch('/api/metrics', { method: 'POST', body, keepalive: true }).catch(() => {});
    }
    if (!S.editRoi) {
      // patch only the numbers so the video element is not recreated every second
      const nums = document.querySelectorAll('.dev-stats .num');
      const st = S.stats, f = (v) => (v == null ? '–' : Math.round(v) + ' ms');
      if (nums.length === 4) { nums[0].textContent = st.fps.toFixed(1); nums[1].textContent = f(st.rtt); nums[2].textContent = f(st.e2e); nums[3].textContent = `${st.sent} / ${st.lost}`; }
    }
  }, 1000);
  setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); }, 10_000);

  // keep the screen on; stop sending in the background
  let wakeLock = null;
  async function lockScreen() {
    try { if (S.running && 'wakeLock' in navigator && !document.hidden) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not allowed */ }
  }
  document.addEventListener('visibilitychange', () => {
    S.hidden = document.hidden;
    if (!document.hidden) lockScreen();
    render();
  });

  // ------------------------------------------------------------ ROI editor (admin only)
  async function checkAdmin() {
    try {
      const r = await fetch('/api/auth/status', { credentials: 'same-origin' });
      if (r.ok) { const me = await r.json(); S.isAdmin = me.user?.role === 'admin'; render(); }
    } catch { /* not logged in */ }
  }
  let drag = null;
  document.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.roi-handle');
    if (!h || !S.editRoi) return;
    drag = Number(h.dataset.corner);
    h.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  document.addEventListener('pointermove', (e) => {
    if (drag === null) return;
    const box = $('#preview').getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
    S.editRoi[drag] = [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
    $('#dev-overlay svg.roi polygon').setAttribute('points', S.editRoi.map(([px, py]) => `${px * 100},${py * 100}`).join(' '));
    const el = document.querySelector(`.roi-handle[data-corner="${drag}"]`);
    el.style.left = x * 100 + '%'; el.style.top = y * 100 + '%';
  });
  document.addEventListener('pointerup', () => { drag = null; });

  // ------------------------------------------------------------ actions
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-set],[data-act]');
    if (!t) return;
    if (t.dataset.set) {
      S.settings = { ...S.settings, [t.dataset.set]: Number(t.dataset.v) };
      store.set(S.settings);
      if (t.dataset.set === 'fps' && S.running) startLoop();
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'hello', camera_desc: `${S.camera} · ${navigator.userAgent}`.slice(0, 200), app_version: APP_VERSION, settings: S.settings }));
      return render();
    }
    const act = t.dataset.act;
    if (act === 'start') { start(); return; } // nothing awaited before getUserMedia (iOS user gesture)
    if (act === 'stop') { stop(); return; }
    if (act === 'roi-edit') { S.editRoi = S.roi.map((p) => [...p]); render(); }
    if (act === 'roi-cancel') { S.editRoi = null; render(); }
    if (act === 'roi-save') {
      const res = await fetch(`/api/admin/carts/${encodeURIComponent(S.cart)}/roi`, {
        method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roi_polygon: S.editRoi }),
      }).catch(() => null);
      if (res?.ok) { S.roi = S.editRoi; S.editRoi = null; toast('success', 'บันทึก ROI แล้ว · มีผลกับเฟรมถัดไป'); }
      else toast('danger', res?.status === 403 ? 'ตั้ง ROI ได้เฉพาะ admin' : 'บันทึก ROI ไม่สำเร็จ');
      render();
    }
  });

  mount();
  if (!window.isSecureContext) S.error = httpsError();
  render();
  // Enter in the cart / token field = "เริ่มส่งภาพ"
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('#dev-controls input') && !S.running) start(); });
})();
