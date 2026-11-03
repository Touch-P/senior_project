// Stage 4: map labels to products, filter by confidence and ROI (brief section 5 step 4).
import { center, pointInPolygon } from './geometry.js';

/**
 * @typedef {{ class_name: string, product_id: number|null, conf: number, box: number[], in_roi: boolean,
 *             accepted: boolean, track_id: number|null }} Det
 */

/**
 * @param {import('./inferClient.js').Detection[]} raw detections from inference
 * @param {{ catalog: Map<string, { product_id: number }>, confThreshold: number, roi: number[][],
 *           onUnknown?: (className: string) => void }} ctx
 * @returns {Det[]}
 */
export function postprocess(raw, { catalog, confThreshold, roi, onUnknown }) {
  const out = [];
  for (const d of raw) {
    const product = catalog.get(d.class_name);
    if (!product) onUnknown?.(d.class_name);
    const box = [d.x1, d.y1, d.x2, d.y2].map((v) => Math.min(1, Math.max(0, v)));
    const inRoi = pointInPolygon(center(box), roi);
    out.push({
      class_name: d.class_name,
      product_id: product?.product_id ?? null,
      conf: d.conf,
      box,
      in_roi: inRoi,
      accepted: Boolean(product) && inRoi && d.conf >= confThreshold,
      track_id: d.track_id ?? null,
    });
  }
  return out;
}
