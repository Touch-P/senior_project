// Detection scenarios: frame-by-frame box sequences used by INFERENCE_MODE=mock and by the tracker tests.
//
// File format (server/test/scenarios/*.json), coordinates normalised 0-1 like POST /infer:
// {
//   "name": "a08-basket", "description": "...", "cart": "A-08",   // cart: played for this cart label (optional)
//   "default": false,                                             // used for carts without their own scenario
//   "fps": 5, "loop": true, "jitter": 0.004, "seed": 1, "infer_ms": 14,
//   "timeline": [                                                 // segments played in order
//     { "frames": 10, "note": "empty cart", "objects": [] },
//     { "frames": 4, "objects": [
//         { "id": "bb", "class_name": "bengbeng_pack12", "conf": 0.96,
//           "box": [0.36, 0.25, 0.53, 0.46],                      // box at the end of the segment
//           "from": [0.36, 0.75, 0.53, 0.96] } ] }               // optional: box at the start (linear motion)
//   ],
//   "expect": { ... }                                             // optional ground truth for tests (Phase 6)
// }
// "id" is the physical object: the same id in consecutive segments is the same item (mock track_id).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const Box = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const ObjectSpec = z.object({
  id: z.string().min(1),
  class_name: z.string().min(1),
  conf: z.number().min(0).max(1),
  box: Box,
  from: Box.optional(),
});
export const ScenarioSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().default(''),
  cart: z.string().optional(),
  default: z.boolean().default(false),
  source: z.string().optional(),
  fps: z.number().positive().max(60).default(5),
  loop: z.boolean().default(true),
  jitter: z.number().min(0).max(0.05).default(0),
  seed: z.number().int().default(1),
  infer_ms: z.number().nonnegative().default(12),
  timeline: z.array(z.object({
    frames: z.number().int().positive(),
    note: z.string().optional(),
    objects: z.array(ObjectSpec),
  })).min(1),
  expect: z.record(z.string(), z.unknown()).optional(),
});

/** Deterministic PRNG (mulberry32) so every replay of a scenario yields identical boxes. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const r5 = (v) => Math.round(v * 1e5) / 1e5;

/**
 * Expand the timeline into one detection list per frame.
 * With `fps` other than the scenario's own (e.g. 30 for a 4 fps timeline): the same scene recorded at that rate —
 * every segment lasts the same time (frames × fps / sc.fps), objects move along the same lines, the detector jitter
 * is drawn per frame. Used by the 30 fps tracker tests and `npm run rq4 -- --fps 30`.
 * @param {z.infer<typeof ScenarioSchema>} sc
 * @param {number} [fps] default: sc.fps (exactly the frames of the file)
 * @returns {{ i: number, t_ms: number, note?: string, detections: { id: string, track_id: number, class_name: string, conf: number, x1: number, y1: number, x2: number, y2: number }[] }[]}
 */
export function expandScenario(sc, fps = sc.fps) {
  const rand = prng(sc.seed);
  const noise = (amp) => (rand() * 2 - 1) * amp;
  const trackIds = new Map(); // object id -> stable numeric id (what ByteTrack would return)
  const frames = [];
  for (const seg of sc.timeline) {
    const n = fps === sc.fps ? seg.frames : Math.max(1, Math.round((seg.frames * fps) / sc.fps));
    for (let f = 0; f < n; f++) {
      // progress 1/n .. 1 so the last frame of a segment sits exactly on "box"
      const p = (f + 1) / n;
      const detections = [];
      for (const o of seg.objects) {
        const start = o.from ?? o.box;
        const at = o.box.map((v, k) => start[k] + (v - start[k]) * p);
        const [x1, y1, x2, y2] = at.map((v) => clamp01(v + noise(sc.jitter)));
        if (x2 - x1 < 0.005 || y2 - y1 < 0.005) continue; // fully outside the frame
        if (!trackIds.has(o.id)) trackIds.set(o.id, trackIds.size + 1);
        detections.push({
          id: o.id, track_id: trackIds.get(o.id), class_name: o.class_name,
          conf: Math.round(clamp01(o.conf + noise(sc.jitter * 4)) * 1e4) / 1e4,
          x1: r5(x1), y1: r5(y1), x2: r5(x2), y2: r5(y2),
        });
      }
      frames.push({ i: frames.length, t_ms: Math.round((frames.length * 1000) / fps), ...(f === 0 && seg.note ? { note: seg.note } : {}), detections });
    }
  }
  return frames;
}

/**
 * Load and validate every *.json scenario in a folder.
 * @param {string} dir
 * @returns {Map<string, z.infer<typeof ScenarioSchema> & { frames: ReturnType<typeof expandScenario>, file: string }>}
 */
export function loadScenarios(dir) {
  const out = new Map();
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return out; }
  for (const file of files) {
    let raw;
    try { raw = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch (err) {
      throw new Error(`scenario ${file}: invalid JSON (${err.message})`);
    }
    const r = ScenarioSchema.safeParse(raw);
    if (!r.success) throw new Error(`scenario ${file}: ${z.prettifyError(r.error)}`);
    if (out.has(r.data.name)) throw new Error(`scenario ${file}: duplicate name "${r.data.name}"`);
    out.set(r.data.name, { ...r.data, file, frames: expandScenario(r.data) });
  }
  return out;
}
