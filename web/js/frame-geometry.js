'use strict';
/* Smart Cart — frame size rules shared by device.html (and its encoder) and the Node tests.
 * The camera frame must reach the model with its own aspect ratio: never stretched, never cropped.
 * YOLO letterboxes the frame (keeps the ratio, pads the rest), and boxes / ROI are normalised 0-1 to the
 * frame the phone sent, so any stretch or crop here would move them away from the real objects.
 */
(function (root) {
  /**
   * Scale (w, h) so the long side is at most `longSide` px, keeping the ratio. Never upscales.
   * @param {number} w actual video width (video.videoWidth, not the size asked from getUserMedia)
   * @param {number} h actual video height
   * @param {number} longSide e.g. 640
   * @returns {{ width: number, height: number, scale: number } | null}
   */
  function fitLongSide(w, h, longSide) {
    if (!(w > 0 && h > 0 && longSide > 0)) return null;
    const scale = Math.min(1, longSide / Math.max(w, h));
    // the long side comes out exact; the short side is rounded once (error <= 0.5 px, < 0.2 % of the ratio at 640)
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale };
  }

  /**
   * Where an image of (iw, ih) is drawn inside a box of (bw, bh) with object-fit: contain — used to place
   * normalised boxes over a letterboxed <img>/<video>.
   * @returns {{ x: number, y: number, width: number, height: number }}
   */
  function containRect(iw, ih, bw, bh) {
    const s = Math.min(bw / iw, bh / ih);
    const width = iw * s, height = ih * s;
    return { x: (bw - width) / 2, y: (bh - height) / 2, width, height };
  }

  root.SCFrame = { fitLongSide, containRect };
})(typeof globalThis !== 'undefined' ? globalThis : self);
