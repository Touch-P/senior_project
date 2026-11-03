// Send images through the same client the server uses and print detections + timing.
//   npm run infer:probe                                  all web/assets/camera/*.jpg, INFERENCE_MODE from .env
//   npm run infer:probe -- path\to\a.jpg --repeat 20 --track --cart A-08
//   npm run infer:probe -- --mock --cart A-03 --repeat 30  replay the mock scenario instead
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { config, ROOT } from '../server/src/config.js';
import { openDb } from '../server/src/db/connection.js';
import { createInference } from '../server/src/pipeline/inferClient.js';
import { percentile } from '../server/src/routes/admin.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cart: { type: 'string', default: 'A-08' },
    repeat: { type: 'string', default: '1' },
    track: { type: 'boolean', default: false },
    mock: { type: 'boolean', default: false },
    quiet: { type: 'boolean', short: 'q', default: false },
  },
});

const camDir = resolve(ROOT, 'web', 'assets', 'camera');
const files = positionals.length ? positionals.map((p) => resolve(p)) : readdirSync(camDir).filter((f) => f.endsWith('.jpg')).map((f) => join(camDir, f));
const db = openDb(); // read only: mock mode reads the active model
const inference = createInference({ ...config, ...(values.mock ? { INFERENCE_MODE: 'mock' } : {}) }, db);

try {
  const h = await inference.health();
  console.log(`inference ${inference.mode}: ${h.model} on ${h.device} · ${h.names.length} classes`);
} catch (err) {
  console.error(`inference not reachable (${err.code}): ${err.message}\nstart it with: npm run inference`);
  process.exit(1);
}

const rtt = [], inf = [];
let seq = 0;
for (const file of files) {
  const jpeg = readFileSync(file);
  for (let k = 0; k < Number(values.repeat); k++) {
    const t = performance.now();
    const r = await inference.infer({ cart: values.cart, seq: ++seq, jpeg, track: values.track });
    rtt.push(performance.now() - t);
    inf.push(r.infer_ms);
    if (!values.quiet && (k === 0 || values.mock)) {
      const tag = r.scenario ? `${r.scenario}#${r.frame}` : file.replace(ROOT, '.');
      console.log(`\n${tag}  infer ${r.infer_ms} ms · round trip ${(performance.now() - t).toFixed(1)} ms`);
      for (const d of r.detections) {
        console.log(`  ${d.class_name.padEnd(24)} ${d.conf.toFixed(2)}  [${[d.x1, d.y1, d.x2, d.y2].map((v) => v.toFixed(3)).join(', ')}]`
          + (d.track_id !== undefined ? `  track ${d.track_id}` : ''));
      }
    }
  }
}
const f = (v) => (v == null ? '-' : v.toFixed(1));
console.log(`\n${rtt.length} requests · infer p50 ${f(percentile(inf, 50))} p95 ${f(percentile(inf, 95))} ms`
  + ` · round trip (Node -> Python -> Node) p50 ${f(percentile(rtt, 50))} p95 ${f(percentile(rtt, 95))} ms`);
db.close();
