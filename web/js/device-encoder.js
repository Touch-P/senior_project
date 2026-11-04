'use strict';
/* Smart Cart — JPEG encoder for device.html, off the main thread (Worker + OffscreenCanvas).
 * In:  { id, bitmap: ImageBitmap (full camera frame), width, height (from SCFrame.fitLongSide), quality }
 * Out: { id, buf: ArrayBuffer (JPEG), width, height }  or  { id, error }
 * The whole frame is drawn scaled by one factor (width/height keep the camera ratio): no crop, no stretch.
 */
let canvas = null;
let ctx = null;

self.onmessage = async (e) => {
  const { id, bitmap, width, height, quality } = e.data;
  try {
    if (!canvas) {
      canvas = new OffscreenCanvas(width, height);
      ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('OffscreenCanvas 2d context not available');
    }
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const buf = await blob.arrayBuffer();
    self.postMessage({ id, buf, width, height }, [buf]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  } finally {
    bitmap?.close?.();
  }
};
