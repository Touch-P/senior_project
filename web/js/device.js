'use strict';
/* Smart Cart — phone as the cart camera (brief section 9).
 * URL: /device.html?cart=A-07&fps=4&token=…   (QR from Admin > Live "เพิ่ม device (กล้องมือถือ)" or npm run device-link)
 * The camera opens only when "เริ่มส่งภาพ" is pressed (iOS Safari needs a user gesture for getUserMedia), then
 * streams JPEG frames over /ws/device/{cart}?token=… as
 *   JSON header {seq, t_capture, w, h} + "\n" + JPEG bytes   (binary, never base64)
 * at up to 30 fps: a steady clock (requestVideoFrameCallback, else a drift-compensated timer), JPEG encoded off the
 * main thread (Worker + OffscreenCanvas when available), up to MAX_IN_FLIGHT frames waiting for their ack at once
 * (a sliding window instead of stop-and-wait, so throughput is not capped at 1/RTT through a tunnel), skips frames
 * while ws.bufferedAmount > 512 KB (and lowers JPEG quality if that keeps happening, never the size), reconnects
 * with backoff 0.5 s -> 10 s, measures
 *   RTT = send -> ack (frame_seq), E2E = send -> processed   with this phone's performance.now() only,
 * and posts the measurements with navigator.sendBeacon('/api/metrics').
 * "หยุด" closes the socket and turns the camera off. Admins (logged in on this phone) can drag the 4 ROI corners.
 */
(() => {
  const APP_VERSION = 'device-1.2.0';
  const MAX_BUFFERED = 512 * 1024;           // skip a frame while this much is still queued in the socket
  const MAX_IN_FLIGHT = 8;                   // frames sent but not acked yet: 30 fps × ~250 ms RTT (cloudflared) ≈ 8
  const ACK_TIMEOUT_MS = 2000;               // an ack this late is lost: free its slot
  const MAX_ENCODING = 2;                    // JPEG encodes running at once; more = the phone is too slow, skip
  const Q_MIN = 0.4;                         // adaptive JPEG quality floor (size / ratio are never reduced)
  const BACKOFF_MIN_MS = 500, BACKOFF_MAX_MS = 10_000;
  // asked as "ideal" only (see openCamera); 1280×960 = 4:3 like the training photos, but any ratio the camera gives is kept
  const CAMERA_CONSTRAINTS = { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 }, frameRate: { ideal: 30 } };
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
  // fps up to 30 (the server accepts 1-30; same list as the QR in Admin › Live); the default stays 4
  const MAX_FPS = 30;
  const OPTIONS = { fps: [2, 3, 4, 5, 10, 15, 20, 30], size: [480, 640], quality: [0.5, 0.7, 0.9] };
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
    // ?fps= from the QR / device-link: any whole number 1-30 (same rule as the server), else the saved setting
    settings: { ...store.get(), ...(Number.isInteger(urlFps) && urlFps >= 1 && urlFps <= MAX_FPS ? { fps: urlFps } : {}) },
    running: false,             // "เริ่มส่งภาพ" pressed (camera on, socket wanted) until "หยุด"
    conn: 'disconnected',       // connected | updating | disconnected
    hidden: document.hidden,
    sessionActive: null,
    roi: [[0.2, 0.14], [0.8, 0.14], [0.96, 0.99], [0.04, 0.99]],
    editRoi: null,              // copy of the polygon while an admin edits it
    isAdmin: false,
    error: null,
    stats: { sent: 0, lost: 0, rtt: null, e2e: null, fps: 0, camFps: null, skipped: 0 },
    quality: null,              // JPEG quality in use (adaptive, <= settings.quality); null = settings.quality
    camera: '',
  };

  // ------------------------------------------------------------ render (same components as the prototype)
  const seg = (key, values, label) => `<div class="col gap-4"><span class="t-cap dev-label">${label}</span>
    <div class="seg dev-seg" role="radiogroup" aria-label="${label}">${values.map((v) => `<button role="radio" aria-checked="${S.settings[key] === v}" class="${S.settings[key] === v ? 'on' : ''}" data-set="${key}" data-v="${v}">${key === 'size' ? v + ' px' : v}</button>`).join('')}</div></div>`;

  function roiSvg() {
    const poly = S.editRoi ?? S.roi;
    const pts = poly.map(([x, y]) => `${x * 100},${y * 100}`).join(' ');
    const handles = S.editRoi ? poly.map(([x, y], i) => `<button class="roi-handle" data-corner="${i}" style="left:${x * 100}%;top:${y * 100}%" aria-label="มุม ROI ที่ ${i + 1}"></button>`).join('') : '';
    return `<svg class="roi" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon points="${pts}" fill="${S.editRoi ? 'rgba(245,158,11,.12)' : 'none'}" stroke="#F59E0B" stroke-width="2" stroke-dasharray="8 6" vector-effect="non-scaling-stroke"/></svg>${handles}`;
  }

  // The page is mounted once; render() only rewrites the parts around the <video>, so the camera preview
  // never restarts (a new <video> would show black frames and make the encoder get no frame).
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
    $('#dev-stats').innerHTML = STAT_FIELDS.map(([k, label]) =>
      `<div class="col"><span class="t-cap dev-label">${label}</span><span class="t-strong num" data-stat="${k}">${statText(k)}</span></div>`).join('');
    $('#dev-controls').innerHTML = `
        ${S.editRoi ? `<p class="t-cap" style="margin:0">ลากมุมสีเหลืองทั้ง 4 ให้ล้อมพื้นตะกร้า แล้วกดบันทึก มีผลกับเฟรมถัดไปทันที</p>
          <div class="row gap-8"><button class="btn btn-secondary btn-m grow" data-act="roi-cancel">ยกเลิก</button><button class="btn btn-primary btn-m grow" data-act="roi-save">${ic('check', 16)}บันทึก ROI</button></div>`
        : `${S.running ? '' : startFields()}
          ${seg('fps', OPTIONS.fps, 'อัตราเฟรม (fps)')}${seg('size', OPTIONS.size, 'ด้านยาวของภาพ')}${seg('quality', OPTIONS.quality, 'คุณภาพ JPEG')}
          <div class="row gap-8">
            ${S.running ? `<button class="btn btn-danger btn-l grow" data-act="stop">${ic('stop', 18)}หยุด</button>`
              : `<button class="btn btn-primary btn-l grow" data-act="start">${ic('play', 18)}เริ่มส่งภาพ</button>`}
            ${S.isAdmin && S.running ? `<button class="btn btn-secondary btn-l" data-act="roi-edit">${ic('edit', 16)}ตั้ง ROI</button>` : ''}
          </div>`}
        <p class="t-cap dev-label center" style="margin:0">กล้องมองเฉพาะภายในตะกร้า ระบบไม่บันทึกใบหน้า · เก็บภาพเฉพาะเฟรมที่เกิดการหยิบเข้า–ออก</p>`;
  }

  /** numbers under the preview; patched in place every second (the video element is never re-created) */
  const STAT_FIELDS = [['fps', 'ส่งจริง fps'], ['cam', 'กล้อง fps'], ['rtt', 'RTT ส่ง→ack'], ['e2e', 'E2E ส่ง→ผล'], ['sent', 'ส่ง / ไม่ได้ผล'], ['q', 'JPEG q']];
  function statText(k) {
    const st = S.stats, ms = (v) => (v == null ? '–' : Math.round(v) + ' ms');
    if (k === 'fps') return `${st.fps.toFixed(1)} / ${S.settings.fps}`;
    if (k === 'cam') return st.camFps == null ? '–' : st.camFps.toFixed(0);
    if (k === 'rtt') return ms(st.rtt);
    if (k === 'e2e') return ms(st.e2e);
    if (k === 'sent') return `${st.sent} / ${st.lost}`;
    const q = S.quality ?? S.settings.quality;
    return q < S.settings.quality ? `${q.toFixed(2)} ↓` : q.toFixed(2); // ↓ = lowered automatically (slow uplink)
  }
  function patchStats() {
    for (const el of document.querySelectorAll('#dev-stats [data-stat]')) el.textContent = statText(el.dataset.stat);
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

  // JPEG of the current video frame: long side = settings.size, short side from the real ratio (never a fixed
  // 640×480 canvas). Worker + OffscreenCanvas so encoding never blocks the UI or the capture clock; main-thread
  // canvas as fallback (older Safari). Both draw the whole frame scaled by one factor: no crop, no stretch.
  const encoder = (() => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let worker = null, nextId = 0;
    let useWorker = typeof Worker === 'function' && typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function'
      && 'convertToBlob' in OffscreenCanvas.prototype;
    const waiting = new Map();
    function giveUpWorker() {
      useWorker = false;
      worker?.terminate();
      worker = null;
      for (const done of waiting.values()) done(null);
      waiting.clear();
    }
    function startWorker() {
      try {
        worker = new Worker('js/device-encoder.js');
        worker.onmessage = (e) => {
          const done = waiting.get(e.data.id);
          waiting.delete(e.data.id);
          if (e.data.error) { giveUpWorker(); done?.(null); return; }
          done?.(new Uint8Array(e.data.buf));
        };
        worker.onerror = giveUpWorker;
      } catch { giveUpWorker(); }
    }
    async function onMainThread(v, size, quality) {
      // a new size (first frame, or the phone rotated) resizes the canvas; the same size keeps it
      if (canvas.width !== size.width || canvas.height !== size.height) { canvas.width = size.width; canvas.height = size.height; }
      ctx.drawImage(v, 0, 0, size.width, size.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    }
    async function onWorker(v, size, quality) {
      if (!worker) startWorker();
      if (!useWorker) return null;
      const bitmap = await createImageBitmap(v); // this video frame at full size; the worker scales it
      return new Promise((resolve) => {
        const id = ++nextId;
        waiting.set(id, resolve);
        worker.postMessage({ id, bitmap, width: size.width, height: size.height, quality }, [bitmap]);
      });
    }
    return {
      /** @returns {Promise<Uint8Array|null>} */
      async encode(v, size, quality) {
        // PDPA: crop the basket ROI on the phone HERE (instruction 4.6 / docs/roadmap.md): draw only the bounding box
        // of S.roi and put that rectangle in the header (e.g. {crop: [x0, y0, x1, y1]}) so the server can map boxes
        // and the ROI back to the full frame. Off for now: the server still expects full frames.
        if (useWorker) {
          try { const out = await onWorker(v, size, quality); if (out) return out; } catch { giveUpWorker(); }
        }
        return onMainThread(v, size, quality);
      },
    };
  })();

  // ------------------------------------------------------------ connection
  let ws = null, seq = 0, retry = 0, opened = 0, everOpened = false, inFlight = 0, reconnectTimer = null;
  const pending = new Map();   // seq -> { t0, rtt, acked }
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
        if (p && !p.acked) { p.acked = true; inFlight--; p.rtt = now - p.t0; S.stats.rtt = p.rtt; }
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
      inFlight = 0;
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
    stopLoop();
    ws?.close(1000, 'stopped on the phone');
    ws = null;
    S.conn = 'disconnected';
    closeCamera();
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    S.stats.fps = 0;
    S.stats.camFps = null;
    render();
  }

  // ------------------------------------------------------------ capture clock (steady fps)
  // requestVideoFrameCallback fires once per new camera frame; a frame is taken when the next slot of the fps clock
  // is due (due += 1000/fps, so callback/timer jitter never accumulates as drift). Without rVFC: setTimeout to the
  // next slot. Sending is a sliding window: up to MAX_IN_FLIGHT frames may wait for their ack at the same time.
  // rVFC can stop firing (rendering throttled, some mobile Safari builds): a watchdog timer then takes the same slots
  // until callbacks come back, so the stream never stalls.
  const HAS_RVFC = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  const RVFC_STALL_MS = 250;
  const loop = { active: false, due: 0, handle: null, timer: null, encoding: 0, camTimes: [], lastVideoFrame: 0 };
  const rvfcAlive = () => HAS_RVFC && performance.now() - loop.lastVideoFrame < RVFC_STALL_MS;
  const win = { slots: 0, bufferSkips: 0, calm: 0 }; // 2-second window of the adaptive quality
  function startLoop() {
    stopLoop();
    loop.active = true;
    loop.due = performance.now();
    arm();
  }
  function stopLoop() {
    loop.active = false;
    const v = $('#video');
    if (loop.handle != null && v?.cancelVideoFrameCallback) v.cancelVideoFrameCallback(loop.handle);
    loop.handle = null;
    clearTimeout(loop.timer);
    loop.timer = null;
    loop.camTimes = [];
  }
  function arm() {
    if (!loop.active) return;
    const v = $('#video');
    if (HAS_RVFC && v && loop.handle == null) loop.handle = v.requestVideoFrameCallback(onVideoFrame);
    // watchdog / fallback clock: at the next slot (+ the stall margin while rVFC is delivering frames)
    clearTimeout(loop.timer);
    loop.timer = setTimeout(onTimer, Math.max(0, loop.due - performance.now()) + (rvfcAlive() ? RVFC_STALL_MS : 0));
  }
  function onVideoFrame() {
    loop.handle = null;
    const now = performance.now();
    loop.lastVideoFrame = now;
    loop.camTimes.push(now); // camera fps = new video frames per second
    while (loop.camTimes.length && now - loop.camTimes[0] > 3000) loop.camTimes.shift();
    if (isDue(now)) sendFrame();
    arm();
  }
  function onTimer() {
    loop.timer = null;
    if (!rvfcAlive() && isDue(performance.now())) sendFrame(); // rVFC missing or stalled: the timer takes the slot
    arm();
  }
  function isDue(now) {
    // without rVFC frames the timer cannot see new camera frames: never faster than the camera says it runs
    // (a 20 fps camera polled at 30 fps would send every 3rd frame twice)
    const camRate = rvfcAlive() ? null : stream?.getVideoTracks()[0]?.getSettings?.().frameRate;
    const interval = 1000 / (camRate > 0 ? Math.min(S.settings.fps, camRate) : S.settings.fps);
    // camera frames arrive with jitter around their 33 ms: a slot may be taken up to 30 % (max 10 ms) early
    if (now < loop.due - Math.min(10, interval * 0.3)) return false;
    loop.due += interval;
    if (now - loop.due > interval) loop.due = now + interval; // far behind (was hidden, slow phone): restart, no burst
    return true;
  }

  async function sendFrame() {
    if (!S.running || !ws || ws.readyState !== WebSocket.OPEN || S.hidden || S.editRoi) return;
    const now = performance.now();
    win.slots++;
    for (const [k, p] of pending) {
      if (!p.acked && now - p.t0 > ACK_TIMEOUT_MS) { p.acked = true; inFlight--; } // ack lost: free its slot
      if (now - p.t0 > 5000) { pending.delete(k); S.stats.lost++; }
    }
    if (inFlight >= MAX_IN_FLIGHT) { S.stats.skipped++; return; }                          // window full
    if (ws.bufferedAmount > MAX_BUFFERED) { S.stats.skipped++; win.bufferSkips++; return; } // slow uplink: drop it
    if (loop.encoding >= MAX_ENCODING) { S.stats.skipped++; return; }                      // phone cannot encode this fast
    const v = $('#video');
    // only a real decoded camera frame (HAVE_CURRENT_DATA): a video that is not playing yet can report 2×2 or 0×0
    if (!v || v.readyState < 2 || Math.min(v.videoWidth, v.videoHeight) < 16) return;
    const size = SCFrame.fitLongSide(v.videoWidth, v.videoHeight, S.settings.size);
    if (!size) return;
    const tCapture = Date.now();
    loop.encoding++;
    let body = null;
    try { body = await encoder.encode(v, size, S.quality ?? S.settings.quality); } catch { /* skip this frame */ } finally { loop.encoding--; }
    if (!body || !S.running || !ws || ws.readyState !== WebSocket.OPEN) return;
    seq++;
    const header = new TextEncoder().encode(JSON.stringify({ seq, t_capture: tCapture, w: size.width, h: size.height }) + '\n');
    const msg = new Uint8Array(header.length + body.length);
    msg.set(header, 0);
    msg.set(body, header.length);
    pending.set(seq, { t0: performance.now(), rtt: null, acked: false });
    inFlight++;
    ws.send(msg);
    S.stats.sent++;
    sentTimes.push(Date.now());
  }

  /** Every 2 s: buffer skips in > 10 % of the slots -> JPEG quality -0.1 (floor Q_MIN); 6 s without any -> +0.05.
   *  Only the quality adapts: width/height (and so the aspect ratio) stay as chosen. */
  function adaptQuality() {
    const target = S.settings.quality;
    let q = S.quality ?? target;
    if (win.slots >= 4 && win.bufferSkips / win.slots > 0.1) { q = Math.max(Q_MIN, Math.round((q - 0.1) * 100) / 100); win.calm = 0; }
    else if (win.bufferSkips === 0 && q < target && ++win.calm >= 3) { q = Math.min(target, Math.round((q + 0.05) * 100) / 100); win.calm = 0; }
    S.quality = q;
    win.slots = 0;
    win.bufferSkips = 0;
  }

  let seconds = 0;
  setInterval(() => {
    const now = Date.now();
    while (sentTimes.length && now - sentTimes[0] > 3000) sentTimes.shift();
    S.stats.fps = opened && S.running ? sentTimes.length / Math.min(3, Math.max(1, (now - opened) / 1000)) : 0;
    const pnow = performance.now();
    while (loop.camTimes.length && pnow - loop.camTimes[0] > 3000) loop.camTimes.shift(); // rVFC may have stopped
    const cam = loop.camTimes;
    S.stats.camFps = !S.running ? null
      : cam.length > 1 ? ((cam.length - 1) * 1000) / (cam.at(-1) - cam[0])
        : stream?.getVideoTracks()[0]?.getSettings?.().frameRate ?? null; // no rVFC: what the camera reports
    if (++seconds % 2 === 0) adaptQuality();
    if (metrics.length) {
      const body = JSON.stringify({ cart: S.cart, token: S.token, items: metrics.splice(0, 500) });
      if (!navigator.sendBeacon?.('/api/metrics', body)) fetch('/api/metrics', { method: 'POST', body, keepalive: true }).catch(() => {});
    }
    if (!S.editRoi) patchStats(); // only the numbers, so the video element is not recreated every second
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
      if (t.dataset.set === 'quality') S.quality = null; // a new choice restarts the adaptive quality from it
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
