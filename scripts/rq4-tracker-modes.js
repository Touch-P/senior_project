// RQ4 experiment: the same detection sequences through the three counting modes (instruction 2.3).
//   npm run rq4                                   all scenarios with an "expect" block (server/test/scenarios)
//   npm run rq4 -- --session <id> [--db db/smartcart.db]   a recorded real session (detections table), per-mode result
//
// Metrics (instruction 2.3):
//   cart accuracy        share of sessions whose final cart equals the truth for every product
//   wrong events/session |ADD|+|REMOVE|+|CORRECTION| differences from the expected events, averaged per session
// Configurations:
//   (a) frame      per-frame counts, every change is an event (PRESENCE_RULES=false) — the naive baseline
//   (b) window     sliding window W=8 + hysteresis K=3 + presence/exit-evidence rules — the system as deployed
//   (c) bytetrack  ByteTrack track IDs (scenario object ids stand in for them) + presence rules
//   plus (b') window without presence rules, to separate the effect of smoothing from the effect of 7.1-7.3.
// Results: exports/rq4/<time>.csv and a table on the terminal. Synthetic scenarios check the logic;
// the numbers for the thesis come from recorded sessions with a manual ground truth.
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { config, ROOT } from '../server/src/config.js';
import { checkExpect, replayScenario } from '../server/src/pipeline/replay.js';
import { loadScenarios } from '../server/src/pipeline/scenarios.js';

const CONFIGS = [
  { id: 'a-frame', mode: 'frame', presence: false },
  { id: 'b-window', mode: 'window', presence: true },
  { id: 'b-window-nopresence', mode: 'window', presence: false },
  { id: 'c-bytetrack', mode: 'bytetrack', presence: true },
];

const { values: opt } = parseArgs({ options: { session: { type: 'string' }, db: { type: 'string', default: config.dbPath } } });

/** Frames of a recorded session as a scenario (detections as the model returned them, at their real times). */
function recordedScenario(dbPath, sessionId) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const s = db.prepare('SELECT s.session_id, c.label FROM shopping_sessions s JOIN carts c USING (cart_id) WHERE s.session_id = ?').get(sessionId);
  if (!s) throw new Error(`session ${sessionId} not found in ${dbPath}`);
  const frames = db.prepare('SELECT frame_id, t_received_ms FROM frames WHERE session_id = ? AND dropped = 0 AND error IS NULL ORDER BY t_received_ms').all(sessionId);
  const dets = db.prepare('SELECT class_name, conf, x1, y1, x2, y2 FROM detections WHERE frame_id = ?');
  const t0 = frames[0]?.t_received_ms ?? 0;
  const out = {
    name: `session-${sessionId.slice(0, 8)}`, cart: s.label, expect: { cart: s.label },
    frames: frames.map((f, i) => ({ i, t_ms: f.t_received_ms - t0, detections: dets.all(f.frame_id) })),
  };
  db.close();
  return out;
}

const pad = (v, n) => String(v).padEnd(n);
if (opt.session) {
  const sc = recordedScenario(resolve(opt.db), opt.session);
  console.log(`${sc.name} (${sc.cart}) · ${sc.frames.length} frames — final cart per configuration:\n`);
  for (const c of CONFIGS) {
    const r = await replayScenario(sc, { mode: c.mode, presence: c.presence, checkout: true });
    console.log(`${pad(c.id, 22)} items ${JSON.stringify(r.items)} · events ${JSON.stringify(r.events)} · reasons ${r.reasons.map((x) => x.reason_code).join(',') || '-'}`);
    r.db.close();
  }
  process.exit(0);
}

const scenarios = [...loadScenarios(config.scenariosDir).values()].filter((s) => s.expect?.items);
const rows = [];
for (const c of CONFIGS) {
  let correct = 0, wrongEvents = 0;
  for (const sc of scenarios) {
    const r = await replayScenario(sc, { mode: c.mode, presence: c.presence });
    const itemsOk = JSON.stringify(Object.entries(r.items).sort()) === JSON.stringify(Object.entries(sc.expect.items).sort());
    const exp = sc.expect.events ?? {};
    const wrong = ['ADD', 'REMOVE', 'CORRECTION'].reduce((n, k) => n + Math.abs((r.events[k] ?? 0) - (exp[k] ?? 0)), 0);
    if (itemsOk) correct++;
    wrongEvents += wrong;
    rows.push({ config: c.id, scenario: sc.name, cart_ok: itemsOk ? 1 : 0, wrong_events: wrong, diffs: checkExpect(sc, r).join(' | ') });
    r.db.close();
  }
  c.accuracy = correct / scenarios.length;
  c.wrongPerSession = wrongEvents / scenarios.length;
}

console.log(`${scenarios.length} scenarios (server/test/scenarios with expectations)\n`);
console.log(`${pad('configuration', 24)}${pad('cart accuracy', 16)}wrong events / session`);
for (const c of CONFIGS) console.log(`${pad(c.id, 24)}${pad((c.accuracy * 100).toFixed(1) + ' %', 16)}${c.wrongPerSession.toFixed(2)}`);
const dir = resolve(ROOT, 'exports', 'rq4');
mkdirSync(dir, { recursive: true });
const file = resolve(dir, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`);
writeFileSync(file, ['config,scenario,cart_ok,wrong_events,diffs', ...rows.map((r) => `${r.config},${r.scenario},${r.cart_ok},${r.wrong_events},"${r.diffs.replaceAll('"', "'")}"`)].join('\n') + '\n');
console.log(`\nper-scenario results: ${file.replace(ROOT, '.')}`);
