// WebSocket endpoints on the same HTTP(S) server:
//   /ws/admin                      dashboard (admin/staff login cookie)
//   /ws/display/{session_id}       customer screen (session id = capability)
//   /ws/device/{cart}?token=...    phone camera (device token), binary frames
import { WebSocketServer } from 'ws';
import { COOKIE_NAME, getSessionUser } from '../auth/sessions.js';
import { parseCookies } from '../http/security.js';
import { cartSnapshot } from '../services/cart.js';
import { verifyDeviceToken } from '../services/devices.js';

const HEARTBEAT_MS = 10_000;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Split a binary device message: JSON header + "\n" + JPEG bytes (brief section 5 step 1).
 * @param {Buffer} buf
 * @returns {{ header: Record<string, unknown>, jpeg: Buffer } | null}
 */
export function parseFrameMessage(buf) {
  const nl = buf.indexOf(0x0a);
  if (nl <= 0 || nl > 4096) return null;
  try {
    const header = JSON.parse(buf.subarray(0, nl).toString('utf8'));
    if (!Number.isInteger(header.seq)) return null;
    return { header, jpeg: buf.subarray(nl + 1) };
  } catch {
    return null;
  }
}

function reject(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Same-origin check against cross-site WebSocket hijacking (browsers always send Origin). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (load test, scripts)
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

/**
 * @param {import('node:http').Server} server
 * @param {{ db: import('better-sqlite3').Database, hub: ReturnType<typeof import('./hub.js').createHub>, log: import('pino').Logger,
 *           onFrame?: (f: { cart: string, cartId: number, deviceId: number, seq: number, header: object, jpeg: Buffer, tReceivedMs: number, ws: import('ws').WebSocket }) => void }} deps
 */
export function attachWebSockets(server, { db, hub, log, onFrame = () => {} }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const touchDevice = db.prepare('UPDATE devices SET last_seen_ms = ?, user_agent = COALESCE(?, user_agent) WHERE device_id = ?');
  const cartInfo = db.prepare(`SELECT c.roi_polygon, s.session_id FROM carts c
    LEFT JOIN shopping_sessions s ON s.cart_id = c.cart_id AND s.status = 'active' WHERE c.cart_id = ?`);
  const setDeviceInfo = db.prepare('UPDATE devices SET camera_desc = COALESCE(?, camera_desc), app_version = COALESCE(?, app_version) WHERE device_id = ?');

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const [, ws, kind, param] = url.pathname.split('/');
    if (ws !== 'ws') return reject(socket, 404, 'Not Found');
    if (!sameOrigin(req)) return reject(socket, 403, 'Forbidden');

    if (kind === 'admin' && !param) {
      const user = getSessionUser(db, parseCookies(req.headers.cookie)[COOKIE_NAME]);
      if (!user) return reject(socket, 401, 'Unauthorized');
      return wss.handleUpgrade(req, socket, head, (client) => {
        hub.addAdmin(client);
        client.send(JSON.stringify({ type: 'hello', role: user.role, server_ts: Date.now() }));
        client.on('message', (data, isBinary) => {
          if (isBinary) return;
          let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
          if (msg.type === 'watch') hub.watch(client, typeof msg.cart === 'string' && /^[A-Za-z]-\d{2}$/.test(msg.cart) ? msg.cart : null);
          else if (msg.type === 'ping') client.send(JSON.stringify({ type: 'pong', server_ts: Date.now() }));
        });
        watch(client);
      });
    }

    if (kind === 'display' && param && UUID.test(param)) {
      const snap = cartSnapshot(db, param);
      if (!snap) return reject(socket, 404, 'Not Found');
      return wss.handleUpgrade(req, socket, head, (client) => {
        hub.addDisplay(param, client);
        client.send(JSON.stringify(snap));
        watch(client);
      });
    }

    if (kind === 'device' && param) {
      const label = decodeURIComponent(param);
      const device = verifyDeviceToken(db, label, url.searchParams.get('token'));
      if (!device) return reject(socket, 401, 'Unauthorized');
      return wss.handleUpgrade(req, socket, head, (client) => {
        hub.setDevice(label, client);
        // what the phone needs to draw the preview: ROI of this cart and whether a customer session is running
        const cartRow = cartInfo.get(device.cart_id);
        client.send(JSON.stringify({ type: 'config', cart: label, roi_polygon: JSON.parse(cartRow.roi_polygon),
          session_active: Boolean(cartRow.session_id), server_ts: Date.now() }));
        const ua = req.headers['user-agent']?.slice(0, 300) ?? null;
        let lastTouch = Date.now();
        touchDevice.run(lastTouch, ua, device.device_id);
        hub.toAdmins({ type: 'device_status', cart: label, connection: 'connected' });
        client.on('message', (data, isBinary) => {
          const tReceivedMs = Date.now();
          if (!isBinary) {
            let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
            if (msg.type === 'ping') client.send(JSON.stringify({ type: 'pong', server_ts: tReceivedMs }));
            // device.html describes itself once per connection (stored for the experiment log, instruction part 3)
            if (msg.type === 'hello') {
              setDeviceInfo.run(String(msg.camera_desc ?? '').slice(0, 200) || null, String(msg.app_version ?? '').slice(0, 50) || null, device.device_id);
            }
            return;
          }
          const frame = parseFrameMessage(data);
          if (!frame) return client.send(JSON.stringify({ type: 'error', error: 'BAD_FRAME' }));
          // ack immediately so the phone can send the next frame and measure RTT (brief section 5 step 2)
          client.send(JSON.stringify({ type: 'ack', seq: frame.header.seq, frame_seq: frame.header.seq, server_ts: tReceivedMs }));
          if (tReceivedMs - lastTouch > 5000) { lastTouch = tReceivedMs; touchDevice.run(lastTouch, null, device.device_id); }
          onFrame({ cart: label, cartId: device.cart_id, deviceId: device.device_id, seq: frame.header.seq, header: frame.header, jpeg: frame.jpeg, tReceivedMs, ws: client });
        });
        client.once('close', () => {
          if (!hub.isDeviceConnected(label)) hub.toAdmins({ type: 'device_status', cart: label, connection: 'disconnected' });
        });
        watch(client);
      });
    }

    reject(socket, 404, 'Not Found');
  });

  // heartbeat: ping every 10 s, drop clients that missed a pong
  function watch(client) {
    client.isAlive = true;
    client.on('pong', () => { client.isAlive = true; });
    client.on('error', (err) => log.warn({ err: err.message }, 'websocket error'));
  }
  const timer = setInterval(() => {
    for (const client of wss.clients) {
      if (!client.isAlive) { client.terminate(); continue; }
      client.isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_MS);
  timer.unref();

  return { wss, close: () => { clearInterval(timer); for (const c of wss.clients) c.terminate(); wss.close(); } };
}
