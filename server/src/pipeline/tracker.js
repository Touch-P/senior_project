// Stage 5: stable count per class + box association across frames (brief section 5 step 5, instruction 2.3).
//
// Three counting modes for RQ4, same interface (TRACKER_MODE):
//   frame     (a) count per frame, no smoothing (baseline)
//   window    (b) mode of the last W frames; ADD after K consecutive frames above, REMOVE after 2W below
//   bytetrack (c) count confirmed track IDs (ByteTrack from inference, IoU association as fallback)
//
// Every mode assigns local_track_id to accepted detections (greedy IoU with the previous boxes of the same
// class), which the presence engine uses to follow single items.
import { iou } from './geometry.js';

export const TRACKER_MODES = ['frame', 'window', 'bytetrack'];

/** Most frequent value; ties go to `prefer` when it is among the tied values (hysteresis), else the larger. */
export function modeOf(values, prefer) {
  const freq = new Map();
  for (const v of values) freq.set(v, (freq.get(v) ?? 0) + 1);
  const top = Math.max(...freq.values());
  const tied = [...freq].filter(([, n]) => n === top).map(([v]) => v);
  return tied.includes(prefer) ? prefer : Math.max(...tied);
}

/**
 * @param {{ mode?: 'frame'|'window'|'bytetrack', window?: number, addK?: number, iouMatch?: number }} [opts]
 */
export function createTracker({ mode = 'window', window: W = 8, addK: K = 3, iouMatch = 0.3 } = {}) {
  if (!TRACKER_MODES.includes(mode)) throw new Error(`unknown TRACKER_MODE ${mode}`);
  const removeAfter = 2 * W;
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
   * @returns {{ frame: number, raw: Map<string, number>, stable: Map<string, number>, changes: { class_name: string, from: number, to: number }[], state: 'stable'|'updating' }}
   */
  function update(detections) {
    frame++;
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
      if (s.hist.length > W) s.hist.shift();
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
    return { frame, raw, stable, changes, state: pending ? 'updating' : 'stable' };
  }

  return { mode, update, tracks, get frame() { return frame; } };
}
