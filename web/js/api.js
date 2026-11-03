'use strict';
/* Smart Cart — data layer (brief section 10).
 * Normal mode: REST + /ws/admin updates. Mock mode (?mock=1): the prototype's data.js, no backend at all
 * (fallback for exam day). Views never call fetch themselves; they go through API.
 */
const API = (() => {
  const params = new URLSearchParams(location.search);
  // ?mock=1 sticks for the tab so hash navigation keeps it; ?mock=0 turns it off
  let mock = false;
  try {
    if (params.has('mock')) sessionStorage.setItem('sc-mock', params.get('mock') === '0' ? '0' : '1');
    mock = sessionStorage.getItem('sc-mock') === '1';
  } catch { mock = params.get('mock') === '1'; }

  class ApiError extends Error {
    constructor(status, body) {
      super(body?.message || `HTTP ${status}`);
      this.status = status;
      this.code = body?.error || 'HTTP_ERROR';
      this.body = body || {};
    }
  }

  async function req(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method, credentials: 'same-origin',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, { error: 'NETWORK', message: 'เชื่อมต่อ server ไม่ได้' });
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) throw new ApiError(res.status, json);
    return json;
  }

  // ------------------------------------------------------------ admin WebSocket (live updates)
  const handlers = new Map();
  let ws = null, retry = 0, wantWs = false, watching = null;
  function connectWs() {
    if (mock || !wantWs || (ws && ws.readyState <= 1)) return;
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/admin`);
    ws.binaryType = 'blob';
    ws.onopen = () => { retry = 0; if (watching) ws.send(JSON.stringify({ type: 'watch', cart: watching })); emit('ws', { open: true }); };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return emit('frame', e.data);
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      emit(msg.type, msg);
    };
    ws.onclose = () => {
      emit('ws', { open: false });
      if (!wantWs) return;
      setTimeout(connectWs, Math.min(10_000, 1000 * 2 ** retry++));
    };
  }
  function emit(type, msg) { for (const fn of handlers.get(type) ?? []) { try { fn(msg); } catch (err) { console.error(err); } } }

  return {
    get mock() { return mock; },
    ApiError,
    get: (p) => req('GET', p),
    post: (p, b = {}) => req('POST', p, b),
    put: (p, b = {}) => req('PUT', p, b),
    patch: (p, b = {}) => req('PATCH', p, b),
    del: (p) => req('DELETE', p),
    /** subscribe to a /ws/admin message type ('cart_event', 'change_reason', 'frame' (binary), 'ws', …) */
    on(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); return () => handlers.get(type).delete(fn); },
    startLive() { wantWs = true; connectWs(); },
    stopLive() { wantWs = false; ws?.close(); ws = null; },
    /** receive camera frames of one cart (Live detail); null stops */
    watch(cart) {
      watching = cart;
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'watch', cart }));
    },
  };
})();
