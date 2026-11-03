'use strict';
/* Live mode glue between the prototype UI (app.js) and the server: session restore, server-side login,
 * logout and the admin WebSocket. In mock mode (?mock=1) nothing here runs and app.js behaves exactly
 * like the prototype with data.js.
 */
const Live = (() => {
  const L = { meta: null, ready: false };

  async function boot() {
    if (API.mock) return;
    try {
      const [status, meta] = await Promise.all([API.get('/api/auth/status'), API.get('/api/meta')]);
      L.meta = meta;
      if (status.user) { state.user = status.user; API.startLive(); }
    } catch (err) {
      toast('danger', `เชื่อมต่อ server ไม่ได้ · เปิด ?mock=1 เพื่อใช้ข้อมูลตัวอย่าง (${err.message})`);
    }
    L.ready = true;
  }

  /** Server-side login (replaces the client-side ACCOUNTS check of the prototype). */
  async function login() {
    const remember = document.querySelector('.login-card input[type="checkbox"]')?.checked ?? false;
    try {
      const { user } = await API.post('/api/auth/login', { email: state.loginEmail.trim(), password: state.loginPw, remember });
      state.user = user; state.loginErr = false; state.attempts = 3; state.loginPw = ''; state.loginLockedUntil = null;
      API.startLive();
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

  return { boot, login, logout, demoAccounts, get meta() { return L.meta; } };
})();
