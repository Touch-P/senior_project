// Stage 5: stable count per class + box association across frames (brief section 5 step 5, instruction 2.3).
//
// Three counting modes for RQ4, same interface (TRACKER_MODE):
//   frame     (a) count per frame, no smoothing (baseline)
//   window    (b) mode of the last W frames; ADD after K consecutive frames above, REMOVE after 2W below
//   bytetrack (c) count confirmed track IDs (ByteTrack from inference, IoU association as fallback)
//
// Every mode assigns local_track_id to accepted detections (greedy IoU with the previous boxes of the same
// class), which the presence engine uses to follow single items.
//
// Frame rate: W=8, K=3 (REMOVE after 2W) were tuned at ~4 fps, i.e. a ~2 s window, ADD after ~0.75 s, REMOVE after
// ~4 s. At 30 fps the same frame counts would be a 0.27 s window and ADD/REMOVE would flicker. The tracker therefore
// measures the rate of the frames it really gets (per cart: after inference drops, not what the phone sends) and
// multiplies every frame count by `scale` = fps / refFps (frame counts rounded), with 20 % hysteresis. Below
// 1.5 × refFps (6 fps) scale is exactly 1, so 4 fps (and the 2-5 fps settings / scenarios) behave as before; at
// 30 fps scale = 7.5: W=60 frames (2.0 s), K=23 (0.77 s), REMOVE after 120 (4.0 s) — the 4 fps seconds.
// Callers that pass no timestamp always get scale 1.
import { center, iou } from './geometry.js';

export const TRACKER_MODES = ['frame', 'window', 'bytetrack'];
export const MAX_SCALE = 16;

/** Frame count n (tuned at refFps) at frame-rate scale s. */
export const scaled = (n, s) => (s === 1 ? n : Math.max(n, Math.round(n * s)));

/**
 * Frame-rate estimate -> multiplier of the frame counts (W, K, 2W ...): 1 below 1.5 × refFps, else fps / refFps.
 *  - measured: median gap between the frames of the last 2 s, once there is at least 1 s of them (one burst or one
 *    late frame does not move it; a short back-to-back burst never counts as a frame rate)
 *  - before that: the fps the phone said it streams at (hello settings), so a 30 fps session is scaled from its
 *    first frame; without one, scale 1 (the old behaviour) until the rate is measured
 * @param {{ refFps?: number, spanMs?: number, maxFps?: number }} [opts]
 */
export function createRateScale({ refFps = 4, spanMs = 2000, maxFps = 30 } = {}) {
  const times = [];
  let scale = 1, fps = null;
  return {
    /**
     * @param {number} [t] frame time in ms (server receive time); ignored when not a number
     * @param {number} [declaredFps] target fps of the camera (device hello), used until the rate is measured
     */
    update(t, declaredFps) {
      if (!Number.isFinite(t)) return scale;
      if (times.length && t < times.at(-1)) times.length = 0; // clock went back (replay restarted): start over
      times.push(t);
      while (times.length > 3 && t - times[0] > spanMs) times.shift();
      if (times.length >= 3 && t - times[0] >= spanMs / 2) {
        const gaps = times.slice(1).map((v, i) => v - times[i]).sort((a, b) => a - b);
        const mid = gaps.length >> 1;
        const gap = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
        if (gap > 0) fps = 1000 / gap;
      } else if (Number.isFinite(declaredFps) && declaredFps > 0) {
        fps = Math.min(maxFps, declaredFps);
      } else {
        return scale;
      }
      if (fps == null) return scale;
      const r = fps / refFps;
      const next = r < 1.5 ? 1 : Math.min(MAX_SCALE, Math.round(r * 100) / 100);
      // hysteresis: follow only a clear change of rate (> 20 %), so jitter around 30 fps never moves the windows
      if (next !== scale && Math.abs(next - scale) / scale > 0.2) scale = next;
      return scale;
    },
    get scale() { return scale; },
    get fps() { return fps; },
  };
}

/** Most frequent value; ties go to `prefer` when it is among the tied values (hysteresis), else the larger. */
export function modeOf(values, prefer) {
  const freq = new Map();
  for (const v of values) freq.set(v, (freq.get(v) ?? 0) + 1);
  const top = Math.max(...freq.values());
  const tied = [...freq].filter(([, n]) => n === top).map(([v]) => v);
  return tied.includes(prefer) ? prefer : Math.max(...tied);
}

/**
 * @param {{ mode?: 'frame'|'window'|'bytetrack', window?: number, addK?: number, iouMatch?: number, maxJump?: number,
 *           refFps?: number }} [opts] window / addK are frame counts at refFps (default 4 fps)
 */
export function createTracker({ mode = 'window', window: W0 = 8, addK: K0 = 3, iouMatch = 0.3, maxJump = 0.25, refFps = 4 } = {}) {
  if (!TRACKER_MODES.includes(mode)) throw new Error(`unknown TRACKER_MODE ${mode}`);
  const rate = createRateScale({ refFps });
  // frame counts of the current scale (scale 1 = the configured W / K)
  let W = W0, K = K0, removeAfter = 2 * W0;
  let frame = 0;
  let nextId = 1;
  /** @type {Map<number, { id: number, class_name: string, box: number[], hits: number, last: number, extId: number|null }>} */
  const tracks = new Map();
  /** per class: raw history, stable count, consecutive frames above/below */
  const classes = new Map();
  const cls = (c) => {
    if (!classes.has(c)) classes.set(c, { hist: [], stable: 0, up: 0, down: 0 });
    return classes.get(c);
  };

  function associate(dets) {
    const free = new Set([...tracks.values()].filter((t) => frame - t.last <= W));
    for (const d of dets) {
      let best = null, bestIou = iouMatch;
      if (mode === 'bytetrack' && d.track_id != null) {
        best = [...free].find((t) => t.extId === d.track_id && t.class_name === d.class_name) ?? null;
      }
      if (!best) {
        for (const t of free) {
          if (t.class_name !== d.class_name) continue;
          const v = iou(t.box, d.box);
          if (v >= bestIou) { best = t; bestIou = v; }
        }
      }
      if (!best) {
        // fast motion (an item being put in) leaves no overlap between frames: nearest centre of the same class
        let bestDist = maxJump;
        const c = center(d.box);
        for (const t of free) {
          if (t.class_name !== d.class_name || t.last !== frame - 1) continue;
          const tc = center(t.box);
          const dist = Math.hypot(c[0] - tc[0], c[1] - tc[1]);
          if (dist <= bestDist) { best = t; bestDist = dist; }
        }
      }
      if (!best) {
        best = { id: nextId++, class_name: d.class_name, box: d.box, hits: 0, last: frame, extId: d.track_id ?? null };
        tracks.set(best.id, best);
      } else {
        free.delete(best);
      }
      best.box = d.box;
      best.hits++;
      best.last = frame;
      if (d.track_id != null) best.extId = d.track_id;
      d.local_track_id = best.id;
    }
    for (const [id, t] of tracks) if (frame - t.last > removeAfter) tracks.delete(id);
  }

  /**
   * @param {import('./postprocess.js').Det[]} detections all detections of the frame (only accepted ones count)
   * @param {number} [t] frame time in ms; drives the frame-rate scale (omitted = scale 1, the 4 fps behaviour)
   * @param {number} [declaredFps] fps the camera said it streams at (used until the real rate is measured)
   * @returns {{ frame: number, raw: Map<string, number>, stable: Map<string, number>, changes: { class_name: string, from: number, to: number }[],
   *             state: 'stable'|'updating', scale: number, fps: number|null }}
   */
  function update(detections, t, declaredFps) {
    frame++;
    const scale = rate.update(t, declaredFps);
    W = scaled(W0, scale); K = scaled(K0, scale); removeAfter = 2 * W;
    const accepted = detections.filter((d) => d.accepted);
    associate(accepted);
    const raw = new Map();
    for (const d of accepted) raw.set(d.class_name, (raw.get(d.class_name) ?? 0) + 1);
    if (mode === 'bytetrack') {
      // count tracks confirmed by K hits and seen within the window, per class
      raw.clear();
      for (const t of tracks.values()) {
        if (t.hits >= K && frame - t.last < W) raw.set(t.class_name, (raw.get(t.class_name) ?? 0) + 1);
      }
    }
    for (const c of raw.keys()) cls(c);

    const changes = [];
    let pending = false;
    for (const [c, s] of classes) {
      const n = raw.get(c) ?? 0;
      s.hist.push(n);
      while (s.hist.length > W) s.hist.shift(); // while: the window may also shrink when the rate drops
      let target;
      if (mode === 'frame') {
        target = n;
      } else if (mode === 'bytetrack') {
        target = n;
      } else {
        const m = modeOf(s.hist, s.stable);
        s.up = m > s.stable ? s.up + 1 : 0;
        s.down = m < s.stable ? s.down + 1 : 0;
        target = s.stable;
        if (s.up >= K) target = m;
        else if (s.down >= removeAfter) target = m;
        else if (m !== s.stable) pending = true;
      }
      if (target !== s.stable) {
        changes.push({ class_name: c, from: s.stable, to: target });
        s.stable = target;
        s.up = s.down = 0;
      }
    }
    const stable = new Map([...classes].filter(([, s]) => s.stable > 0).map(([c, s]) => [c, s.stable]));
    return { frame, raw, stable, changes, state: pending ? 'updating' : 'stable', scale, fps: rate.fps };
  }

  return { mode, update, tracks, get frame() { return frame; }, get scale() { return rate.scale; } };
}
