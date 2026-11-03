// POST /api/metrics — E2E measurements from device.html (brief section 5 step 9).
// Sent with navigator.sendBeacon, so the body arrives as text/plain; the device token authenticates it.
// All values come from the phone's own clock (send -> ack, send -> processed); never mixed with server time.
import express, { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../http/errors.js';
import { verifyDeviceToken } from '../services/devices.js';

const ms = z.number().nonnegative().max(60_000).nullable().optional();
const Body = z.object({
  cart: z.string().max(10),
  token: z.string().max(100),
  items: z.array(z.object({ seq: z.number().int().nonnegative(), rtt_ms: ms, e2e_ms: ms })).max(500),
}).strict();

export function metricsRoutes({ db, pipeline }) {
  const r = Router();
  r.post('/', express.text({ type: () => true, limit: '64kb' }), (req, res) => {
    let raw;
    try { raw = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body; } catch {
      throw new HttpError(400, 'BAD_JSON', 'ข้อมูลไม่ใช่ JSON');
    }
    const body = parse(Body, raw);
    const device = verifyDeviceToken(db, body.cart, body.token);
    if (!device) throw new HttpError(401, 'DEVICE_TOKEN_INVALID', 'token ของอุปกรณ์ไม่ถูกต้อง');
    const updated = pipeline ? pipeline.recordMetrics(device.cart_id, body.items) : 0;
    res.json({ updated });
  });
  return r;
}
