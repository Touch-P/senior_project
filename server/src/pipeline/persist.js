// SQL used by the pipeline. Statements are prepared once per database.
const cache = new WeakMap();

/** @param {import('better-sqlite3').Database} db */
export function statements(db) {
  if (cache.has(db)) return cache.get(db);
  const s = {
    activeSession: db.prepare("SELECT session_id, started_at_ms FROM shopping_sessions WHERE cart_id = ? AND status = 'active'"),
    cart: db.prepare('SELECT cart_id, store_id, label, roi_polygon FROM carts WHERE cart_id = ?'),
    catalog: db.prepare('SELECT product_id, class_name, name_th, brand, product_line, flavor, variant, category, sub_category FROM products WHERE is_active = 1'),
    activeModel: db.prepare('SELECT model_id, name, conf_threshold FROM model_versions WHERE is_active = 1'),
    modelByName: db.prepare('SELECT model_id FROM model_versions WHERE name = ?'),
    price: db.prepare(`SELECT COALESCE(promo_price, price) FROM product_prices
                       WHERE product_id = ? AND is_current = 1 AND (store_id IS NULL OR store_id = ?)
                       ORDER BY store_id IS NULL LIMIT 1`),
    insertFrame: db.prepare(`INSERT INTO frames (session_id, cart_id, model_id, seq, width, height, jpeg_bytes, t_capture_device_ms,
        t_received_ms, t_infer_start_ms, t_infer_end_ms, infer_ms, t_tracker_ms, t_db_ms, t_pushed_ms, dropped, error, image_path,
        num_detections)
      VALUES (@session_id, @cart_id, @model_id, @seq, @width, @height, @jpeg_bytes, @t_capture_device_ms,
        @t_received_ms, @t_infer_start_ms, @t_infer_end_ms, @infer_ms, @t_tracker_ms, @t_db_ms, @t_pushed_ms, @dropped, @error,
        @image_path, @num_detections)`),
    frameTimes: db.prepare('UPDATE frames SET t_db_ms = ?, t_pushed_ms = ? WHERE frame_id = ?'),
    frameImage: db.prepare('UPDATE frames SET image_path = ? WHERE frame_id = ? AND image_path IS NULL'),
    insertDet: db.prepare(`INSERT INTO detections (frame_id, product_id, class_name, conf, x1, y1, x2, y2, in_roi, accepted, local_track_id)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertEvent: db.prepare(`INSERT INTO cart_events (session_id, event_type, product_id, qty_delta, qty_after, unit_price,
        confidence_avg, source, frame_id, local_track_id, note, occurred_at_ms)
      VALUES (@session_id, @event_type, @product_id, @qty_delta, @qty_after, @unit_price, @confidence_avg, @source, @frame_id,
        @local_track_id, @note, @occurred_at_ms)`),
    currentItem: db.prepare('SELECT history_id, qty, unit_price FROM cart_item_history WHERE session_id = ? AND product_id = ? AND is_current = 1'),
    closeItem: db.prepare('UPDATE cart_item_history SET valid_to_ms = ?, is_current = 0 WHERE history_id = ?'),
    openItem: db.prepare(`INSERT INTO cart_item_history (session_id, product_id, qty, unit_price, valid_from_ms, caused_by_event_id)
                          VALUES (?, ?, ?, ?, ?, ?)`),
    feedbackFrame: db.prepare('UPDATE user_feedback SET frame_id = ? WHERE feedback_id = ? AND frame_id IS NULL'),
    touchFrameMetrics: db.prepare(`UPDATE frames SET rtt_ms = COALESCE(@rtt_ms, rtt_ms), e2e_ms = COALESCE(@e2e_ms, e2e_ms)
                                   WHERE frame_id = (SELECT MAX(frame_id) FROM frames WHERE cart_id = @cart_id AND seq = @seq)`),
  };
  cache.set(db, s);
  return s;
}

/** Insert a frame row and its detections; returns frame_id. */
export function writeFrame(db, row, detections) {
  const s = statements(db);
  const frameId = Number(s.insertFrame.run(row).lastInsertRowid);
  for (const d of detections) {
    s.insertDet.run(frameId, d.product_id, d.class_name, d.conf, d.box[0], d.box[1], d.box[2], d.box[3],
      d.in_roi ? 1 : 0, d.accepted ? 1 : 0, d.local_track_id ?? null);
  }
  return frameId;
}

/**
 * Change the quantity of one product in a session: cart_events row + cart_item_history SCD2 (close the current
 * row, open a new one). Price is the snapshot taken at ADD time; later price changes do not touch the cart.
 * @returns {{ event_id: number, qty_before: number, qty_after: number, unit_price: number|null }}
 */
export function applyItemChange(db, { sessionId, storeId, productId, delta, eventType, frameId = null, trackId = null,
  confidence = null, source = 'auto', note = null, at = Date.now() }) {
  const s = statements(db);
  const cur = s.currentItem.get(sessionId, productId);
  const before = cur?.qty ?? 0;
  const after = Math.max(0, before + delta);
  // keep the price the item was added at; a brand-new line takes today's price
  const unitPrice = cur?.unit_price ?? s.price.pluck().get(productId, storeId) ?? null;
  const eventId = Number(s.insertEvent.run({
    session_id: sessionId, event_type: eventType ?? (delta > 0 ? 'ADD' : 'REMOVE'), product_id: productId,
    qty_delta: after - before, qty_after: after, unit_price: unitPrice, confidence_avg: confidence, source,
    frame_id: frameId, local_track_id: trackId, note, occurred_at_ms: at,
  }).lastInsertRowid);
  if (cur) s.closeItem.run(at, cur.history_id);
  s.openItem.run(sessionId, productId, after, unitPrice, at, eventId);
  return { event_id: eventId, qty_before: before, qty_after: after, unit_price: unitPrice };
}
