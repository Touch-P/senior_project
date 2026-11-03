import './setup.js';
import bcrypt from 'bcrypt';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { resetLoginLimits } from '../src/auth/login.js';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { logger } from '../src/logger.js';
import { createInference } from '../src/pipeline/inferClient.js';
import { config } from '../src/config.js';
import { createHub } from '../src/ws/hub.js';
import { attachWebSockets } from '../src/ws/server.js';

export const ADMIN = { email: 'admin@smartcart.co.th', password: 'change-me' };
export const STAFF = { email: 'staff@smartcart.co.th', password: 'staff-pass' };

/**
 * Start the full server (HTTP, in-memory DB) on a random port.
 * @param {{ onFrame?: Function, inference?: (db) => object }} [opts] inference defaults to mock mode (no Python needed)
 */
export async function startServer({ onFrame, inference: makeInference } = {}) {
  resetLoginLimits();
  const db = openDb(':memory:');
  migrate(db);
  await seed(db, { probeInference: false });
  db.prepare(`INSERT INTO admin_users (email, password_hash, display_name, initials, role) VALUES (?, ?, 'วิภา ร้านดี', 'วร', 'staff')`)
    .run(STAFF.email, await bcrypt.hash(STAFF.password, 4));
  const hub = createHub();
  const inference = makeInference ? makeInference(db) : createInference({ ...config, INFERENCE_MODE: 'mock', MOCK_SCENARIO: '' }, db);
  const server = http.createServer(createApp({ db, hub, log: logger, inference }));
  const ws = attachWebSockets(server, { db, hub, log: logger, onFrame });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db, hub, base, inference,
    wsBase: base.replace('http', 'ws'),
    async close() { ws.close(); await new Promise((r) => server.close(r)); db.close(); },
  };
}

/** Minimal client that keeps the session cookie between requests. */
export function client(base) {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie();
    if (set.length) cookie = set.map((c) => c.split(';')[0]).filter((c) => !/=$/.test(c)).join('; ');
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, json, headers: res.headers, setCookie: set };
  };
  return {
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b, h) => call('POST', p, b, h),
    put: (p, b, h) => call('PUT', p, b, h),
    patch: (p, b, h) => call('PATCH', p, b, h),
    del: (p, h) => call('DELETE', p, undefined, h),
    call,
    get cookie() { return cookie; },
    async login(creds, remember = false) { return call('POST', '/api/auth/login', { ...creds, remember }); },
  };
}

/**
 * Open a WebSocket; resolves with the socket and a queue of parsed JSON messages, or rejects with the HTTP status.
 * @returns {Promise<{ ws: WebSocket, next: (type?: string, ms?: number) => Promise<any> }>}
 */
export function openWs(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const queue = [], waiters = [];
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      const i = waiters.findIndex((w) => !w.type || w.type === msg.type);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else queue.push(msg);
    });
    const next = (type, ms = 2000) => {
      const i = queue.findIndex((m) => !type || m.type === type);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        const w = { type, resolve: (m) => { clearTimeout(t); res(m); } };
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`timeout waiting for ${type}`)); }, ms);
        waiters.push(w);
      });
    };
    ws.once('open', () => resolve({ ws, next }));
    ws.once('unexpected-response', (req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.once('error', reject);
  });
}
