// /api/demo — scenario playback for demos without a phone (INFERENCE_MODE=mock only, 404 otherwise).
// The session id is the capability, like /ws/display/{session_id}: the customer screen that owns the session
// can drive its own cart and nothing else.
import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../http/errors.js';

export function demoRoutes({ demo }) {
  const r = Router();
  r.use((req, res, next) => next(demo?.enabled ? undefined : new HttpError(404, 'DEMO_DISABLED', 'โหมดจำลองใช้ได้เฉพาะ INFERENCE_MODE=mock')));
  r.get('/', (req, res) => res.json({ scenarios: demo.scenarios() }));
  r.post('/play', (req, res) => {
    const body = parse(z.object({ session_id: z.uuid(), scenario: z.string().regex(/^[a-z0-9-]{1,60}$/) }).strict(), req.body);
    res.json(demo.play(body.session_id, body.scenario));
  });
  return r;
}
