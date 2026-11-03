// In-process registry of WebSocket clients and the publish helpers used by routes and the pipeline.
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

/**
 * @typedef {object} Hub
 * @property {(msg: object) => void} toAdmins
 * @property {(sessionId: string, msg: object) => void} toDisplay
 * @property {(cartLabel: string, msg: object) => void} toDevice
 * @property {(cartLabel: string) => boolean} isDeviceConnected
 */

export function createHub() {
  /** @type {Set<WebSocket>} */
  const admins = new Set();
  /** @type {Map<string, Set<WebSocket>>} session_id -> display sockets */
  const displays = new Map();
  /** @type {Map<string, WebSocket>} cart label -> camera socket (one per cart) */
  const devices = new Map();
  /** @type {Map<string, Set<WebSocket>>} cart label -> admin sockets watching its camera (Live detail) */
  const watchers = new Map();
  /** in-process events between services and the pipeline: session_closing, feedback */
  const events = new EventEmitter();

  const send = (ws, msg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  };

  return {
    admins, displays, devices, watchers, events,
    addAdmin(ws) {
      admins.add(ws);
      ws.once('close', () => { admins.delete(ws); for (const set of watchers.values()) set.delete(ws); });
    },
    /** An admin opened (cart) or left (null) the Live detail of a cart; one cart per socket. */
    watch(ws, cart) {
      for (const [label, set] of watchers) { set.delete(ws); if (!set.size) watchers.delete(label); }
      if (!cart) return;
      if (!watchers.has(cart)) watchers.set(cart, new Set());
      watchers.get(cart).add(ws);
    },
    isWatched: (cart) => (watchers.get(cart)?.size ?? 0) > 0,
    /** Binary camera frame (JSON header + newline + JPEG) to the admins watching this cart. */
    toWatchers(cart, buf) {
      for (const ws of watchers.get(cart) ?? []) if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1_000_000) ws.send(buf);
    },
    addDisplay(sessionId, ws) {
      if (!displays.has(sessionId)) displays.set(sessionId, new Set());
      displays.get(sessionId).add(ws);
      ws.once('close', () => {
        const set = displays.get(sessionId);
        set?.delete(ws);
        if (set && !set.size) displays.delete(sessionId);
      });
    },
    /** Register the camera of a cart; a newer connection replaces the older one. */
    setDevice(label, ws) {
      const old = devices.get(label);
      if (old && old !== ws) old.close(4000, 'replaced by a newer connection');
      devices.set(label, ws);
      ws.once('close', () => { if (devices.get(label) === ws) devices.delete(label); });
    },
    toAdmins(msg) { const s = JSON.stringify(msg); for (const ws of admins) send(ws, s); },
    toDisplay(sessionId, msg) { const s = JSON.stringify(msg); for (const ws of displays.get(sessionId) ?? []) send(ws, s); },
    toDevice(label, msg) { const ws = devices.get(label); if (ws) send(ws, msg); },
    closeDisplays(sessionId, code = 4001, reason = 'session closed') {
      for (const ws of displays.get(sessionId) ?? []) ws.close(code, reason);
    },
    isDeviceConnected: (label) => devices.get(label)?.readyState === WebSocket.OPEN,
    stats: () => ({ watching: [...watchers.keys()], admins: admins.size, displays: [...displays.values()].reduce((n, s) => n + s.size, 0), devices: devices.size }),
  };
}
