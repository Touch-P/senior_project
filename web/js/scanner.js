'use strict';
/* Barcode scanning with the phone camera (brief section 8).
 * Camera opening follows TMPPO/example_of_phonecam.html (getUserMedia on a <video>), but with the rear
 * camera. Decoding: BarcodeDetector (Chrome Android) for ean_13, ean_8, upc_a, upc_e, code_128; browsers
 * without it (Safari iOS) load the local ZXing bundle from web/vendor/ (no CDN on the shop LAN).
 * A code is accepted only after the same value is read twice in a row; the phone vibrates on success.
 */
const Scanner = (() => {
  const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];
  let stream = null, timer = null, zxingControls = null, stopped = true;

  function loadZxing() {
    if (window.ZXingBrowser) return Promise.resolve(window.ZXingBrowser);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/zxing-browser/zxing-browser.min.js';
      s.onload = () => resolve(window.ZXingBrowser);
      s.onerror = () => reject(new Error('โหลดตัวอ่านบาร์โค้ดสำรองไม่ได้'));
      document.head.appendChild(s);
    });
  }

  async function nativeDetector(wanted) {
    if (!('BarcodeDetector' in window)) return null;
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = wanted.filter((f) => supported.includes(f));
      return formats.length ? new window.BarcodeDetector({ formats }) : null;
    } catch { return null; }
  }

  /**
   * @param {HTMLVideoElement} video
   * @param {(code: string, engine: string) => void} onCode called once with the confirmed value
   * @param {(message: string) => void} onError
   * @param {{ formats?: string[] }} [opts] e.g. ['qr_code'] for the cart QR on the customer screen
   */
  async function start(video, onCode, onError, { formats = FORMATS } = {}) {
    stop();
    stopped = false;
    if (!window.isSecureContext) return onError('กล้องใช้ได้เฉพาะหน้า https:// หรือ localhost');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment', width: { ideal: 1280 } } });
    } catch (err) {
      return onError(err.name === 'NotAllowedError' ? 'อนุญาตให้ใช้กล้องใน browser ก่อน' : `เปิดกล้องไม่ได้: ${err.message}`);
    }
    if (stopped) return stop();
    video.srcObject = stream;
    await video.play().catch(() => {});

    let last = null;
    const confirm = (value, engine) => {
      if (!value || stopped) return;
      if (value !== last) { last = value; return; } // need the same value twice in a row
      navigator.vibrate?.(80);
      stop();
      onCode(value, engine);
    };

    const detector = await nativeDetector(formats);
    if (detector) {
      timer = setInterval(async () => {
        if (stopped || video.readyState < 2) return;
        try {
          const codes = await detector.detect(video);
          confirm(codes[0]?.rawValue, 'BarcodeDetector');
        } catch { /* frame not ready */ }
      }, 150);
      return 'BarcodeDetector';
    }
    try {
      const Z = await loadZxing();
      if (stopped) return;
      const reader = new Z.BrowserMultiFormatReader();
      zxingControls = await reader.decodeFromVideoElement(video, (result) => { if (result) confirm(result.getText(), 'ZXing'); });
      return 'ZXing';
    } catch (err) {
      onError(err.message);
    }
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
    timer = null;
    try { zxingControls?.stop(); } catch { /* already stopped */ }
    zxingControls = null;
    for (const t of stream?.getTracks() ?? []) t.stop(); // always release the camera when the modal closes
    stream = null;
  }

  return { start, stop, FORMATS };
})();
