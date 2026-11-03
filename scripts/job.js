// Run one batch job by hand (the server runs them on a schedule too):
//   npm run job -- analytics [--day 2026-11-02]
//   npm run job -- timeout | retention [--days 30] [--no-vacuum] | backup
//   npm run export:feedback [-- --all]        npm run export:latency [-- --hours 24 | --session <id>]
// Every run is recorded in job_runs; running a job twice gives the same result.
import { parseArgs } from 'node:util';
import { config } from '../server/src/config.js';
import { openDb } from '../server/src/db/connection.js';
import { migrate } from '../server/src/db/migrate.js';
import { runAnalytics } from '../server/src/jobs/analytics.js';
import { exportFeedback, exportLatency } from '../server/src/jobs/exports.js';
import { backup, closeIdleSessions, retention } from '../server/src/jobs/maintenance.js';

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    day: { type: 'string' }, days: { type: 'string' }, all: { type: 'boolean', default: false },
    hours: { type: 'string' }, session: { type: 'string' }, 'no-vacuum': { type: 'boolean', default: false },
  },
});
const job = positionals[0];
const db = openDb();
migrate(db);
const hub = { toAdmins() {}, toDisplay() {}, toDevice() {}, closeDisplays() {}, events: null };
const jobs = {
  analytics: () => runAnalytics(db, o.day ? { day: o.day } : {}),
  timeout: () => closeIdleSessions(db, hub, { idleMs: config.SESSION_IDLE_MS }),
  retention: () => retention(db, { days: o.days ? Number(o.days) : config.RETENTION_DAYS, framesDir: config.framesDir, root: config.ROOT, vacuum: !o['no-vacuum'] }),
  backup: () => backup(db, { dir: config.backupDir, keep: config.BACKUP_KEEP }),
  'export-feedback': () => exportFeedback(db, { root: config.ROOT, outDir: config.exportDir, all: o.all }),
  'export-latency': () => exportLatency(db, { outDir: config.exportDir, sessionId: o.session ?? null, since: o.hours ? Date.now() - Number(o.hours) * 3_600_000 : 0 }),
};
if (!jobs[job]) {
  console.error(`usage: npm run job -- <${Object.keys(jobs).join(' | ')}>`);
  process.exit(1);
}
try {
  const r = await jobs[job]();
  console.log(`${job}: ${r.message ?? JSON.stringify(r)}`);
} catch (err) {
  console.error(`${job} failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
