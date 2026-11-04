// Tracker / presence windows in seconds, not frames (P2.8): W=8, K=3 were tuned at ~4 fps; at 30 fps every
// frame count is multiplied by round(fps / 4) so ADD / REMOVE keep their timing. 4 fps must behave exactly as before.
import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { config } from '../src/config.js';
import { checkExpect, replayScenario } from '../src/pipeline/replay.js';
import { expandScenario, loadScenarios } from '../src/pipeline/scenarios.js';
import { createRateScale, createTracker, scaled } from '../src/pipeline/tracker.js';

const det = (class_name, box, conf = 0.9, extra = {}) => ({ class_name, box, conf, accepted: true, in_roi: true, product_id: 1, track_id: null, ...extra });
const A = [0.3, 0.4, 0.5, 0.6];
const T0 = 1_800_000_000_000;

/** feed `n` frames at `fps` starting at time *t (ms) */
function feed(tracker, n, fps, clock, dets) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(tracker.update(dets.map((d) => ({ ...d })), clock.t));
    clock.t += 1000 / fps;
  }
  return out;
}

describe('frame-rate scale', () => {
  const settle = (fps, frames = 60, jitter = 0) => {
    const r = createRateScale({ refFps: 4 });
    let t = T0, s;
    for (let i = 0; i < frames; i++) { s = r.update(t); t += 1000 / fps + (i % 2 ? jitter : -jitter); }
    return s;
  };

  test('below 6 fps the scale is exactly 1 (the tuned behaviour); above it fps / 4: 10 -> 2.5, 15 -> 3.75, 30 -> 7.5', () => {
    assert.deepEqual([2, 3, 4, 5, 5.9].map((f) => settle(f)), [1, 1, 1, 1, 1]);
    assert.deepEqual([10, 15, 20, 30].map((f) => settle(f)), [2.5, 3.75, 5, 7.5]);
    // frame counts at 30 fps = the 4 fps seconds: W 8 -> 60 (2.0 s), K 3 -> 23 (0.77 s), REMOVE 2W -> 120 (4.0 s)
    assert.deepEqual([scaled(8, 7.5), scaled(3, 7.5), 2 * scaled(8, 7.5), scaled(8, 1), scaled(3, 1)], [60, 23, 120, 8, 3]);
  });

  test('declared fps (phone hello) from the 1st frame; measured after 1 s; bursts, jitter and one late frame do not move it', () => {
    const d = createRateScale({ refFps: 4 });
    assert.equal(d.update(T0, 30), 7.5, 'a 30 fps phone is scaled before any ADD can happen');
    const m = createRateScale({ refFps: 4 });
    let t = T0;
    for (let i = 0; i < 29; i++) { assert.equal(m.update(t), 1, 'no declared fps: old behaviour until 1 s is measured'); t += 1000 / 30; }
    assert.ok(Math.abs(m.update(t + 40) - 7.5) < 0.1, 'measured once 1 s of frames is there');
    const b = createRateScale({ refFps: 4 });
    for (let i = 0; i < 50; i++) assert.equal(b.update(T0 + i * 2), 1, 'frames sent back to back (tests, a flushed backlog) are no frame rate');
    assert.equal(settle(30, 120, 8), 7.5, '±8 ms jitter');
    t = T0 + 100;
    const r = createRateScale({ refFps: 4 });
    for (let i = 0; i < 60; i++) { r.update(t); t += 33.3; }
    r.update(t + 1); r.update(t + 2); // burst of two frames
    assert.ok(Math.abs(r.update(t + 400) - 7.5) < 0.1, 'one 400 ms hole');
    assert.equal(createRateScale().update(undefined, 30), 1, 'no timestamp: scale 1');
  });

  test('hysteresis: a rate wobbling 28-32 fps keeps one scale; a real change (30 -> 15 fps) is followed', () => {
    const r = createRateScale({ refFps: 4 });
    let t = T0;
    const seen = new Set();
    for (let i = 0; i < 600; i++) { t += 1000 / (30 + 2 * Math.sin(i / 20)); seen.add(r.update(t)); }
    const used = [...seen].filter((s) => s > 1);
    assert.equal(used.length, 1, `scales used: ${used}`);
    for (let i = 0; i < 60; i++) { t += 1000 / 15; r.update(t); }
    assert.equal(r.scale, 3.75);
  });
});

describe('tracker timing at 30 fps = timing at 4 fps', () => {
  test('4 fps with timestamps gives exactly the frames-only results (old behaviour)', () => {
    const seq = [];
    for (let i = 0; i < 120; i++) {
      const n = i < 10 ? 0 : i < 40 ? (i % 7 === 0 ? 0 : 1) : i < 70 ? 2 : i % 5 === 0 ? 1 : 0;
      seq.push(Array.from({ length: n }, (_, k) => det('lay_big_ori', [0.1 + k * 0.4, 0.4, 0.3 + k * 0.4, 0.6])));
    }
    for (const mode of ['frame', 'window', 'bytetrack']) {
      const a = createTracker({ mode }), b = createTracker({ mode });
      const clock = { t: T0 };
      for (const dets of seq) {
        const ra = a.update(dets.map((d) => ({ ...d })));
        const rb = b.update(dets.map((d) => ({ ...d })), clock.t);
        clock.t += 250;
        assert.deepEqual([rb.changes, [...rb.stable], rb.state, rb.scale], [ra.changes, [...ra.stable], ra.state, 1], mode);
      }
    }
  });

  test('window mode: ADD after ~0.8 s (not 0.1 s), a 0.5 s flicker is ignored, REMOVE after ~4 s', () => {
    const t = createTracker({ mode: 'window', window: 8, addK: 3 });
    const clock = { t: T0 };
    feed(t, 30, 30, clock, []); // 1 s empty basket: the rate is known
    let r = feed(t, 45, 30, clock, [det('lay_big_ori', A)]);
    const addAt = r.findIndex((x) => x.changes.length);
    assert.ok(addAt >= 22 && addAt <= 26, `ADD after ${addAt} frames = ${(addAt / 30).toFixed(2)} s (4 fps: 3 frames = 0.75 s)`);
    assert.equal(r.at(-1).scale, 7.5);
    r = feed(t, 15, 30, clock, []); // 0.5 s not seen
    assert.ok(r.every((x) => x.stable.get('lay_big_ori') === 1), 'flicker: still 1');
    feed(t, 30, 30, clock, [det('lay_big_ori', A)]);
    r = feed(t, 200, 30, clock, []);
    const removedAt = r.findIndex((x) => x.changes.length);
    assert.ok(removedAt / 30 >= 3.5 && removedAt / 30 <= 5, `REMOVE after ${(removedAt / 30).toFixed(2)} s (4 fps: >= 16 frames = 4 s)`);
  });

  test('without the scale the same 30 fps stream would ADD after 0.1 s (what this fixes)', () => {
    const t = createTracker({ mode: 'window', window: 8, addK: 3, refFps: 1e9 }); // scaling off
    const clock = { t: T0 };
    feed(t, 30, 30, clock, []);
    const r = feed(t, 10, 30, clock, [det('lay_big_ori', A)]);
    assert.equal(r.findIndex((x) => x.changes.length), 2);
  });

  test('bytetrack mode: a track needs ~0.8 s of hits at 30 fps', () => {
    const t = createTracker({ mode: 'bytetrack', window: 8, addK: 3 });
    const clock = { t: T0 };
    feed(t, 30, 30, clock, []);
    const r = feed(t, 40, 30, clock, [det('mama_cup_ok_hotKR', A, 0.9, { track_id: 7 })]);
    const at = r.findIndex((x) => x.stable.get('mama_cup_ok_hotKR') === 1);
    assert.ok(at >= 22 && at <= 26, `${at}`);
  });
});

describe('RQ4 scenarios replayed at 30 fps', () => {
  const scenarios = [...loadScenarios(config.scenariosDir).values()].filter((s) => s.expect?.items);

  test('every scenario with expectations gives the expected cart, events and reasons at 30 fps (window + bytetrack)', async () => {
    assert.ok(scenarios.length >= 18);
    for (const mode of ['window', 'bytetrack']) {
      for (const sc of scenarios) {
        // the same seconds as the source recording: W / K refer to the scenario's own rate (4 or 5 fps)
        const s30 = { ...sc, frames: expandScenario(sc, 30) };
        assert.ok(s30.frames.length > sc.frames.length * 5);
        const r = await replayScenario(s30, { mode, presence: true, refFps: sc.fps, fps: 30 });
        assert.deepEqual(checkExpect(s30, r), [], `${mode} ${sc.name}`);
        r.db.close();
      }
    }
  });

  test('4 fps reasons scenarios (r01-r12) pass at 30 fps with the default reference of 4 fps', async () => {
    for (const sc of scenarios.filter((s) => s.fps === 4)) {
      const s30 = { ...sc, frames: expandScenario(sc, 30) };
      const r = await replayScenario(s30, { mode: 'window', presence: true, fps: 30 });
      assert.deepEqual(checkExpect(s30, r), [], sc.name);
      r.db.close();
    }
  });
});
