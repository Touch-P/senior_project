// Simulated phone cameras (instruction part 3.4): N carts stream JPEG frames like device.html does
// (next frame only after the previous ack, at most FPS per second), then report RTT / E2E / drops.
//
//   npm run loadtest -- --carts 1 --fps 4 --seconds 30
//   npm run loadtest -- --carts 1,5,10,20 --seconds 60 --image server/test/fixtures/frames/img-1321.jpg
//   npm run loadtest -- --base https://192.168.1.20:8443 --insecure        (through the LAN address)
//
// Needs the server running and the admin password (ADMIN_PASSWORD in .env or --password).
// Each simulated cart gets its own shopping session, which is checked out at the end.
// Results: exports/loadtest/<time>.csv (one row per frame) + a summary table on the terminal.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';
import { config, ROOT } from '../server/src/config.js';
import { openDb } from '../server/src/db/connection.js';
import { CART_LABELS } from '../server/src/db/seed.js';
import { percentile } from '../server/src/routes/admin.js';

const { values: opt } = parseArgs({
  options: {
    base: { type: 'string', default: `http://localhost:${config.PORT}` },
    carts: { type: 'string', default: '1' },
    fps: { type: 'string', default: '4' },
    seconds: { type: 'string', default: '30' },
    image: { type: 'string', multiple: true },
    email: { type: 'string', default: config.ADMIN_EMAIL },
    password: { type: 'string', default: config.ADMIN_PASSWORD },
    insecure: { type: 'boolean', default: false },
  },
});
if (opt.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed LAN cert, test machine only

const fixtures = resolve(ROOT, 'server', 'test', 'fixtures', 'frames');
const images = (opt.image?.length ? opt.image.map((p) => resolve(p)) : readdirSync(fixtures).filter((f) => f.endsWith('.jpg')).map((f) => join(fixtures, f)))
  .map((f) => readFileSync(f));
const fps = Number(opt.fps), seconds = Number(opt.seconds);
const levels = opt.carts.split(',').map(Number);

let cookie = '';
async function api(method, path, body) {
  const res = await fetch(new URL(path, opt.base), {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie();
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json?.error ?? ''} ${json?.message ?? ''}`);
  return json;
}

function runCart(label, token, sessionId, rows) {
  return new Promise((resolveCart, reject) => {
    const wsUrl = new URL(`/ws/device/${label}?token=${token}`, opt.base.replace(/^http/, 'ws'));
    const ws = new WebSocket(wsUrl, { rejectUnauthorized: !opt.insecure });
    const sent = new Map(); // seq -> { t0, rtt }
    const metrics = [];
    let seq = 0, waitingAck = false, stopAt = 0, timer;
    const flushMetrics = () => {
      if (!metrics.length) return;
      fetch(new URL('/api/metrics', opt.base), { method: 'POST', body: JSON.stringify({ cart: label, token, items: metrics.splice(0) }) }).catch(() => {});
    };
    const tick = () => {
      if (Date.now() >= stopAt) {
        clearInterval(timer);
        setTimeout(() => { flushMetrics(); ws.close(); }, 1500); // let the last answers arrive
        return;
      }
      if (waitingAck || ws.readyState !== WebSocket.OPEN) return; // same back-pressure rule as device.html
      seq++;
      const header = Buffer.from(JSON.stringify({ seq, t_capture: Date.now(), w: 640, h: 480 }) + '\n');
      sent.set(seq, { t0: performance.now(), rtt: null });
      waitingAck = true;
      ws.send(Buffer.concat([header, images[seq % images.length]]));
    };
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', camera_desc: 'load-test (simulated)', app_version: 'loadtest-1' }));
      stopAt = Date.now() + seconds * 1000;
      timer = setInterval(tick, 1000 / fps);
      setInterval(flushMetrics, 2000).unref();
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      const s = sent.get(msg.seq);
      if (!s) return;
      const t = performance.now() - s.t0;
      if (msg.type === 'ack') { s.rtt = t; waitingAck = false; }
      if (msg.type === 'processed') {
        rows.push({ cart: label, session_id: sessionId, seq: msg.seq, rtt_ms: s.rtt, e2e_ms: t, error: msg.error ?? '' });
        metrics.push({ seq: msg.seq, rtt_ms: Math.round(s.rtt * 10) / 10, e2e_ms: Math.round(t * 10) / 10 });
        sent.delete(msg.seq);
      }
    });
    ws.on('close', () => resolveCart({ sent: seq, answered: rows.filter((r) => r.cart === label).length }));
    ws.on('error', reject);
  });
}

await api('POST', '/api/auth/login', { email: opt.email, password: opt.password });
const health = await api('GET', '/api/health');
const db = openDb();
const summary = [];
mkdirSync(resolve(ROOT, 'exports', 'loadtest'), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const allRows = [];

for (const n of levels) {
  const labels = CART_LABELS.slice(0, n);
  console.log(`\n▶ ${n} cart(s) × ${fps} fps × ${seconds} s · inference ${health.inference_mode}`);
  const carts = [];
  for (const label of labels) {
    const open = (await api("GET", `/api/admin/carts/${label}`)).session?.session_id;
    if (open) await api('POST', `/api/sessions/${open}/checkout`, {});
    const { token } = await api('POST', `/api/admin/carts/${label}/device-token`);
    const { session_id } = await api('POST', '/api/sessions', { cart: label });
    carts.push({ label, token, session_id });
  }
  const rows = [];
  const results = await Promise.all(carts.map((c) => runCart(c.label, c.token, c.session_id, rows)));
  for (const c of carts) await api('POST', `/api/sessions/${c.session_id}/checkout`, {});

  const ids = carts.map((c) => c.session_id);
  const ph = ids.map(() => '?').join(',');
  const server = db.prepare(`SELECT queue_ms, infer_call_ms, infer_model_ms, tracker_ms, db_ms, push_ms, server_total_ms
                             FROM v_frame_latency WHERE session_id IN (${ph})`).all(...ids);
  const dropped = db.prepare(`SELECT SUM(dropped) AS d, COUNT(*) AS n FROM frames WHERE session_id IN (${ph})`).get(...ids);
  const col = (k) => server.map((r) => r[k]);
  const sent = results.reduce((a, r) => a + r.sent, 0);
  const ok = rows.filter((r) => !r.error);
  const row = {
    carts: n, fps_target: fps, fps_per_cart: Math.round((sent / n / seconds) * 10) / 10,
    frames: sent, dropped_pct: dropped.n ? Math.round((dropped.d / dropped.n) * 1000) / 10 : 0,
    errors: rows.length - ok.length,
    rtt_p50: percentile(ok.map((r) => r.rtt_ms), 50), rtt_p95: percentile(ok.map((r) => r.rtt_ms), 95),
    e2e_p50: percentile(ok.map((r) => r.e2e_ms), 50), e2e_p95: percentile(ok.map((r) => r.e2e_ms), 95),
    queue_p95: percentile(col('queue_ms'), 95), infer_p95: percentile(col('infer_call_ms'), 95),
    server_p95: percentile(col('server_total_ms'), 95),
  };
  summary.push(row);
  allRows.push(...rows.map((r) => ({ carts: n, ...r })));
}
db.close();

const f1 = (v) => (v == null ? '-' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v));
console.log('\n' + Object.keys(summary[0]).join('\t'));
for (const r of summary) console.log(Object.values(r).map(f1).join('\t'));
const csv = (rows) => [Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).map((v) => (v == null ? '' : typeof v === 'number' ? v.toFixed?.(2) ?? v : v)).join(','))].join('\n') + '\n';
const out = resolve(ROOT, 'exports', 'loadtest', `${stamp}`);
writeFileSync(`${out}-summary.csv`, csv(summary));
if (allRows.length) writeFileSync(`${out}-frames.csv`, csv(allRows));
console.log(`\nsaved ${out.replace(ROOT, '.')}-summary.csv / -frames.csv`);
