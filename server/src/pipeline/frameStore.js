// Frame images: a ring buffer of the recent frames per cart in memory, and JPEG files on disk only for frames
// that caused an event or were reported by the customer (never every frame — brief section 5 step 7).
//
// The ring keeps a time span, not a fixed count: 20 frames were ~5 s at 4 fps but only 0.67 s at 30 fps.
// It holds every frame of the last `seconds` (at least `size` frames, at most `maxFrames`), so a customer report
// keeps the same ~5 s of evidence at any frame rate. evidence() thins that span to about `size` frames for disk.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * @param {{ dir: string, root: string, size?: number, seconds?: number, maxFrames?: number }} opts
 *   dir = data/frames, root = repo root (paths stored relative), size = frames kept at least / saved per report
 */
export function createFrameStore({ dir, root, size = 20, seconds = 5, maxFrames = 200 }) {
  /** @type {Map<string, { seq: number, jpeg: Buffer, frameId: number|null, sessionId: string|null, t: number }[]>} */
  const rings = new Map();
  const spanMs = seconds * 1000;

  const day = (t) => new Date(t).toISOString().slice(0, 10).replaceAll('-', '');

  return {
    push(cart, entry) {
      if (!rings.has(cart)) rings.set(cart, []);
      const ring = rings.get(cart);
      ring.push(entry);
      while (ring.length > maxFrames || (ring.length > size && entry.t - ring[0].t > spanMs)) ring.shift();
      return entry;
    },
    recent(cart) { return rings.get(cart) ?? []; },
    /** Frames to save for a report: all of them up to `size`, else `size` spread evenly over the span (newest kept). */
    evidence(list) {
      if (list.length <= size) return list;
      const step = (list.length - 1) / (size - 1);
      return Array.from({ length: size }, (_, i) => list[Math.round(i * step)]);
    },
    clear(cart) { rings.delete(cart); },
    /** Write one JPEG to data/frames/YYYYMMDD/{session}/{seq}.jpg; returns the path relative to the repo root. */
    save(sessionId, seq, jpeg, t = Date.now()) {
      const file = join(dir, day(t), sessionId, `${seq}.jpg`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, jpeg);
      return relative(root, file).replaceAll('\\', '/');
    },
  };
}
