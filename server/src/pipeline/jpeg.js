// Size of a JPEG from its SOF segment, without decoding it. The frame header from the phone also carries
// {w, h}, but the JPEG is what the model sees: its real size is what the boxes (normalised 0-1) refer to,
// and what the Live view must use as the aspect ratio of the picture.

// SOF0-3, 5-7, 9-11, 13-15 (C4 = DHT, C8 = JPG, CC = DAC are not frame headers)
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * @param {Buffer|Uint8Array} buf JPEG bytes
 * @returns {{ width: number, height: number } | null} null when the bytes are not a readable JPEG
 */
export function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // no length
    if (marker === 0xd9 || marker === 0xda) return null; // end / start of scan before any frame header
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (len < 2) return null;
    if (SOF.has(marker)) {
      if (i + 9 > buf.length) return null;
      const height = (buf[i + 5] << 8) | buf[i + 6];
      const width = (buf[i + 7] << 8) | buf[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

/**
 * Size of a device frame: the JPEG's own size, else the header's {w, h} (test stubs that are not real JPEGs).
 * @param {Buffer} jpeg
 * @param {Record<string, unknown>} [header]
 * @returns {{ w: number|null, h: number|null }}
 */
export function frameSize(jpeg, header = {}) {
  const s = jpegSize(jpeg);
  if (s) return { w: s.width, h: s.height };
  const ok = (v) => Number.isInteger(v) && v > 0 && v <= 10_000;
  return { w: ok(header.w) ? header.w : null, h: ok(header.h) ? header.h : null };
}
