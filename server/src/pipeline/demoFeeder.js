// Demo without a phone (INFERENCE_MODE=mock only): the server plays a scenario for a cart by feeding the
// real pipeline one frame per tick — mock inference returns that scenario's boxes, so the cart, presence,
// reasons and dashboards all update through the normal code path. Used by the customer screen's demo panel.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { HttpError } from '../http/errors.js';

// a real basket photo for the Live detail preview (the mock boxes come from the scenario, not from this image)
const FIXTURE = resolve(config.ROOT, 'server', 'test', 'fixtures', 'frames', 'img-1321.jpg');
const DEMO_JPEG = existsSync(FIXTURE) ? readFileSync(FIXTURE) : Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/**
 * @param {{ db: import('better-sqlite3').Database, hub: any, inference: any, pipeline: any }} deps
 */
export function createDemoFeeder({ db, hub, inference, pipeline }) {
  const running = new Map(); // cart label -> { timer, scenario }
  const enabled = inference.mode === 'mock' && typeof inference.setScenario === 'function';

  function stop(cart) {
    const r = running.get(cart);
    if (!r) return false;
    clearInterval(r.timer);
    running.delete(cart);
    inference.setScenario(cart, null);
    return true;
  }

  return {
    enabled,
    scenarios: () => (enabled ? inference.scenarioList() : []),
    running: (cart) => running.get(cart)?.scenario ?? null,
    /** Play `scenario` once on the cart of an active session. */
    play(sessionId, scenario) {
      if (!enabled) throw new HttpError(404, 'DEMO_DISABLED', 'โหมดจำลองใช้ได้เฉพาะ INFERENCE_MODE=mock');
      const s = db.prepare('SELECT s.status, c.cart_id, c.label FROM shopping_sessions s JOIN carts c USING (cart_id) WHERE s.session_id = ?').get(sessionId);
      if (!s) throw new HttpError(404, 'SESSION_NOT_FOUND', 'ไม่พบ session');
      if (s.status !== 'active') throw new HttpError(409, 'SESSION_CLOSED', 'session นี้จบไปแล้ว');
      if (hub.isDeviceConnected(s.label)) throw new HttpError(409, 'CAMERA_CONNECTED', 'รถเข็นนี้มีกล้องจริงต่ออยู่ จำลองไม่ได้');
      stop(s.label);
      let sc;
      try { sc = inference.setScenario(s.label, scenario); } catch { throw new HttpError(404, 'SCENARIO_NOT_FOUND', 'ไม่พบ scenario'); }
      inference.resetTracks(s.label);
      let seq = 0;
      const frames = sc.frames.length;
      const timer = setInterval(() => {
        seq++;
        pipeline.onFrame({ cart: s.label, cartId: s.cart_id, deviceId: null, seq, header: { seq, w: 640, h: 480 }, jpeg: DEMO_JPEG, tReceivedMs: Date.now() });
        if (seq >= frames) stop(s.label);
      }, Math.round(1000 / sc.fps));
      timer.unref?.();
      running.set(s.label, { timer, scenario });
      const out = { cart: s.label, scenario, frames, seconds: Math.round(frames / sc.fps) };
      hub.toAdmins({ type: 'demo', ...out });
      return out;
    },
    stop,
    stopAll() { for (const cart of [...running.keys()]) stop(cart); },
  };
}
