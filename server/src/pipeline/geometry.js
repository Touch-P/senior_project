// Box / polygon helpers. All coordinates are normalised 0-1; boxes are [x1, y1, x2, y2], polygons [[x, y], ...].

export const center = ([x1, y1, x2, y2]) => [(x1 + x2) / 2, (y1 + y2) / 2];
export const area = ([x1, y1, x2, y2]) => Math.max(0, x2 - x1) * Math.max(0, y2 - y1);

function intersection(a, b) {
  return area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
}

/** Intersection over union of two boxes. */
export function iou(a, b) {
  const i = intersection(a, b);
  const u = area(a) + area(b) - i;
  return u > 0 ? i / u : 0;
}

/** Share of box `target` covered by box `by` (0-1). Used for occlusion: does another box sit on the last position? */
export function coverage(target, by) {
  const a = area(target);
  return a > 0 ? intersection(target, by) / a : 0;
}

/** Ray-casting point-in-polygon. */
export function pointInPolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance from a point to the nearest polygon edge. */
export function distToEdge(p, poly) {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, distToSegment(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
}

/** Size of the polygon's bounding box (the larger side) — "ขนาด ROI" for the 12% edge band. */
export function polygonSize(poly) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

/** True when the box straddles the polygon border (some corners inside, some outside). */
export function crossesEdge([x1, y1, x2, y2], poly) {
  const inside = [[x1, y1], [x2, y1], [x1, y2], [x2, y2]].map((p) => pointInPolygon(p, poly));
  return inside.some(Boolean) && !inside.every(Boolean);
}

/** Parse carts.roi_polygon (JSON) with the brief's default as fallback. */
export const DEFAULT_ROI = [[0.2, 0.14], [0.8, 0.14], [0.96, 0.99], [0.04, 0.99]];
export function parseRoi(json) {
  try {
    const p = JSON.parse(json);
    return Array.isArray(p) && p.length >= 3 ? p : DEFAULT_ROI;
  } catch {
    return DEFAULT_ROI;
  }
}
