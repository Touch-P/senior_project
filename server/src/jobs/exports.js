// Exports (brief section 5, batch line):
//   exportFeedback  customer reports -> exports/retrain/{date}/images, labels (YOLO txt from the detections the
//                   model made = pre-annotation to correct), manifest.csv, data.yaml — ready for Roboflow upload
//   exportLatency   v_frame_latency + device rtt/e2e -> CSV for thesis chapter 4
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runJob } from './jobRuns.js';
import { localDay } from './time.js';

const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
const csv = (header, rows) => [header.join(','), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(','))].join('\n') + '\n';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ root: string, outDir: string, all?: boolean, now?: number }} opts all = include reports already exported
 */
export function exportFeedback(db, { root, outDir, all = false, now = Date.now() }) {
  return runJob(db, 'export_feedback', () => {
    const tz = db.prepare('SELECT timezone FROM stores ORDER BY store_id LIMIT 1').pluck().get() ?? 'Asia/Bangkok';
    const dir = join(outDir, 'retrain', localDay(now, tz));
    const names = JSON.parse(db.prepare('SELECT class_names FROM model_versions WHERE is_active = 1').pluck().get() ?? '[]');
    const index = new Map(names.map((n, i) => [n, i]));
    const reports = db.prepare(`SELECT u.feedback_id, u.session_id, u.issue_type, u.status, u.created_at_ms, u.comment, p.class_name AS product,
        f.frame_id, f.seq, f.image_path, f.width, f.height, c.label AS cart
      FROM user_feedback u JOIN frames f ON f.frame_id = u.frame_id JOIN carts c ON c.cart_id = f.cart_id
      LEFT JOIN products p ON p.product_id = u.product_id
      WHERE f.image_path IS NOT NULL ${all ? '' : "AND u.status = 'open'"} ORDER BY u.feedback_id`).all();
    const dets = db.prepare('SELECT class_name, conf, x1, y1, x2, y2 FROM detections WHERE frame_id = ? AND in_roi = 1');
    const rows = [];
    let missing = 0;
    for (const r of reports) {
      const src = resolve(root, r.image_path);
      if (!existsSync(src)) { missing++; continue; }
      mkdirSync(join(dir, 'images'), { recursive: true });
      mkdirSync(join(dir, 'labels'), { recursive: true });
      const stem = `${r.cart}_${r.session_id.slice(0, 8)}_${r.seq}`;
      copyFileSync(src, join(dir, 'images', `${stem}.jpg`));
      // YOLO txt: class cx cy w h (normalised); classes the model does not know are skipped
      const lines = dets.all(r.frame_id).filter((d) => index.has(d.class_name)).map((d) => [
        index.get(d.class_name), (d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2, d.x2 - d.x1, d.y2 - d.y1,
      ].map((v, i) => (i ? v.toFixed(6) : v)).join(' '));
      writeFileSync(join(dir, 'labels', `${stem}.txt`), lines.join('\n') + (lines.length ? '\n' : ''));
      rows.push({ image: `images/${stem}.jpg`, label: `labels/${stem}.txt`, feedback_id: r.feedback_id, issue_type: r.issue_type,
        product: r.product, comment: r.comment, cart: r.cart, session_id: r.session_id, frame_id: r.frame_id, boxes: lines.length,
        reported_at: new Date(r.created_at_ms).toISOString() });
    }
    if (rows.length) {
      writeFileSync(join(dir, 'manifest.csv'), csv(Object.keys(rows[0]), rows));
      writeFileSync(join(dir, 'data.yaml'), `# labels are the model's own detections (pre-annotation) — correct them before training\npath: .\ntrain: images\nval: images\nnc: ${names.length}\nnames: [${names.map((n) => `'${n}'`).join(', ')}]\n`);
      const mark = db.prepare("UPDATE user_feedback SET status = 'exported' WHERE feedback_id = ? AND status = 'open'");
      db.transaction(() => { for (const r of rows) mark.run(r.feedback_id); })();
    }
    return { dir, rows: rows.length, missing, message: `${rows.length} report(s) -> ${dir}${missing ? ` · ${missing} image file(s) missing` : ''}` };
  });
}

/**
 * @param {{ outDir: string, since?: number, until?: number, sessionId?: string, now?: number }} opts
 */
export function exportLatency(db, { outDir, since = 0, until = Date.now() + 1, sessionId = null, now = Date.now() }) {
  return runJob(db, 'export_latency', () => {
    const rows = db.prepare(`SELECT v.frame_id, v.session_id, c.label AS cart, v.seq, v.t_received_ms, v.queue_ms, v.infer_call_ms, v.infer_model_ms,
        v.tracker_ms, v.db_ms, v.push_ms, v.server_total_ms, v.rtt_ms, v.e2e_ms, f.width, f.height, f.jpeg_bytes, f.num_detections,
        m.name AS model, m.imgsz, d.camera_desc, d.app_version
      FROM v_frame_latency v JOIN frames f USING (frame_id) JOIN carts c ON c.cart_id = f.cart_id
      LEFT JOIN model_versions m ON m.model_id = f.model_id
      LEFT JOIN devices d ON d.cart_id = f.cart_id AND d.device_type = 'camera'
      WHERE v.t_received_ms >= ? AND v.t_received_ms < ? AND (? IS NULL OR v.session_id = ?) ORDER BY v.t_received_ms`)
      .all(since, until, sessionId, sessionId);
    const dropped = db.prepare(`SELECT COUNT(*) FROM frames WHERE dropped = 1 AND t_received_ms >= ? AND t_received_ms < ? AND (? IS NULL OR session_id = ?)`)
      .pluck().get(since, until, sessionId, sessionId);
    const dir = join(outDir, 'latency');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `latency-${new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15)}${sessionId ? `-${sessionId.slice(0, 8)}` : ''}.csv`);
    const header = ['frame_id', 'session_id', 'cart', 'seq', 't_received_ms', 'queue_ms', 'infer_call_ms', 'infer_model_ms', 'tracker_ms', 'db_ms',
      'push_ms', 'server_total_ms', 'rtt_ms', 'e2e_ms', 'width', 'height', 'jpeg_bytes', 'num_detections', 'model', 'imgsz', 'camera_desc', 'app_version'];
    writeFileSync(file, csv(header, rows));
    return { file, rows: rows.length, dropped, message: `${rows.length} frame(s) (+${dropped} dropped) -> ${file}` };
  });
}
