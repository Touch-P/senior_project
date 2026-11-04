'use strict';
/* Live mode glue between the prototype UI (app.js) and the server: session restore, server-side login,
 * logout and the admin WebSocket. In mock mode (?mock=1) nothing here runs and app.js behaves exactly
 * like the prototype with data.js.
 */
const Live = (() => {
  const L = { meta: null, ready: false };

  async function boot() {
    if (API.mock) { if (API.mockAuto) watchForServer(); return; }
    try {
      const [status, meta] = await Promise.all([API.get('/api/auth/status'), API.get('/api/meta')]);
      L.meta = meta;
      if (status.user) { state.user = status.user; API.startLive(); LiveAdmin.loadAlerts().catch(() => {}); }
      await LiveCustomer.boot();
    } catch (err) {
      // no server behind this page (network error, or a static host answering 404 without JSON): use the
      // prototype data instead of empty pages, and switch back by itself once the server answers again
      if (err.status === 0 || (err.status === 404 && err.code === 'HTTP_ERROR')) {
        try { sessionStorage.setItem('sc-mock', 'auto'); location.reload(); return new Promise(() => {}); } catch { /* storage blocked */ }
      }
      toast('danger', `เชื่อมต่อ server ไม่ได้ · เปิด ?mock=1 เพื่อใช้ข้อมูลตัวอย่าง (${err.message})`);
    }
    L.ready = true;
  }

  /** auto mock: tell the user, and leave mock mode for the next reload when /api/meta answers JSON again */
  function watchForServer() {
    setTimeout(() => toast('info', 'ไม่พบ server · ใช้ข้อมูลจำลองของ prototype (ภาพกล้องเป็นภาพตัวอย่าง)'), 300);
    if (location.protocol === 'file:') return;
    const timer = setInterval(async () => {
      try {
        const r = await fetch('/api/meta', { cache: 'no-store' });
        if (!r.ok || !/json/.test(r.headers.get('content-type') ?? '')) return;
        clearInterval(timer);
        try { sessionStorage.removeItem('sc-mock'); } catch { /* ignore */ }
        toast('success', 'server ออนไลน์แล้ว · รีเฟรชหน้าเพื่อใช้ข้อมูลจริง');
      } catch { /* still offline */ }
    }, 10_000);
  }

  /** Server-side login (replaces the client-side ACCOUNTS check of the prototype). */
  async function login() {
    const remember = document.querySelector('.login-card input[type="checkbox"]')?.checked ?? false;
    try {
      const { user } = await API.post('/api/auth/login', { email: state.loginEmail.trim(), password: state.loginPw, remember });
      state.user = user; state.loginErr = false; state.attempts = 3; state.loginPw = ''; state.loginLockedUntil = null;
      API.startLive();
      LiveAdmin.loadAlerts().catch(() => {});
      go('#/a/dashboard');
      toast('success', `ยินดีต้อนรับ ${user.name} (${user.role})`);
    } catch (err) {
      state.loginErr = true;
      if (err.code === 'LOCKED') { state.attempts = 0; state.loginLockedUntil = err.body.locked_until_ms; }
      else if (err.code === 'INVALID_CREDENTIALS') state.attempts = err.body.attempts_left ?? Math.max(0, state.attempts - 1);
      else if (err.code === 'RATE_LIMITED') { state.attempts = 0; state.loginLockedUntil = Date.now() + 5 * 60_000; }
      else toast('danger', err.message);
      render();
    }
  }

  async function logout() {
    try { await API.post('/api/auth/logout'); } catch { /* already logged out */ }
    API.stopLive();
  }

  /** Demo accounts box on the login page: mock = prototype text; live = only in development (/api/meta). */
  function demoAccounts() {
    if (API.mock) return null;
    if (!L.meta?.demo_accounts) return '';
    return `<div class="demo-creds t-cap col gap-4"><span class="t-cap-strong">บัญชีทดลอง (development)</span>
      <span>admin: admin@smartcart.co.th / รหัสตาม ADMIN_PASSWORD ใน .env · <button type="button" data-act="fill-live" data-role="admin">ใส่อีเมล</button></span>
      <span>staff: staff@smartcart.co.th / ค่า DEV_STAFF_PASSWORD (staff1234) · <button type="button" data-act="fill-live" data-role="staff">ใส่ให้</button></span></div>`;
  }

  ACT['fill-live'] = (el) => {
    const r = el.dataset.role;
    state.loginEmail = `${r}@smartcart.co.th`;
    state.loginPw = r === 'staff' ? 'staff1234' : '';
    render();
    if (r === 'admin') document.getElementById('pw')?.focus();
  };

  async function refreshMeta() {
    try { L.meta = await API.get('/api/meta'); } catch { /* keep the old one */ }
  }

  /** Login page chips from the server instead of the prototype's fixed numbers (brief 10). */
  function statChips() {
    const m = L.meta?.active_model;
    return [m ? `mAP50-95 ${m.map50_95.toFixed(3)}` : 'mAP50-95 —', m?.latency_p95_ms ? `Latency p95 ${m.latency_p95_ms} ms` : 'Latency p95 —',
      `${L.meta?.products ?? '—'} สินค้า · โมเดลรู้จัก ${L.meta?.products_in_model ?? '—'}`, 'RTX 5090 benchmark'];
  }

  return { boot, login, logout, demoAccounts, refreshMeta, statChips, get meta() { return L.meta; } };
})();
