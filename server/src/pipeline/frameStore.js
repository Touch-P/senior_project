// Frame images: a ring buffer of the last N frames per cart in memory, and JPEG files on disk only for frames
// that caused an event or were reported by the customer (never every frame — brief section 5 step 7).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * @param {{ dir: string, root: string, size?: number }} opts dir = data/frames, root = repo root (paths stored relative)
 */
export function createFrameStore({ dir, root, size = 20 }) {
  /** @type {Map<string, { seq: number, jpeg: Buffer, frameId: number|null, sessionId: string|null, t: number }[]>} */
  const rings = new Map();

  const day = (t) => new Date(t).toISOString().slice(0, 10).replaceAll('-', '');

  return {
    push(cart, entry) {
      if (!rings.has(cart)) rings.set(cart, []);
      const ring = rings.get(cart);
      ring.push(entry);
      if (ring.length > size) ring.shift();
      return entry;
    },
    recent(cart) { return rings.get(cart) ?? []; },
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
