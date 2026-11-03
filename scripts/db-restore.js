// Restore the database from a backup made by `npm run db:backup` / the nightly job.
//   npm run db:restore                         list the backups
//   npm run db:restore -- db/backups/smartcart-20261103-023000.db --yes
// Stop the server first. The current database is copied to db/backups/pre-restore-<time>.db before it is
// replaced, so a restore can always be undone.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { config } from '../server/src/config.js';
import { restore } from '../server/src/jobs/maintenance.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { yes: { type: 'boolean', default: false } } });
if (!positionals[0]) {
  const files = existsSync(config.backupDir) ? readdirSync(config.backupDir).filter((f) => f.endsWith('.db')).sort().reverse() : [];
  console.log(files.length ? `backups in ${config.backupDir}:\n${files.map((f) => `  ${f}  ${(statSync(join(config.backupDir, f)).size / 1024).toFixed(0)} KB`).join('\n')}` : 'no backups yet (npm run db:backup)');
  console.log('\nrestore: npm run db:restore -- <file> --yes   (server stopped)');
  process.exit(0);
}
if (!values.yes) {
  console.error(`this replaces ${config.dbPath} (a copy is kept in ${config.backupDir}/pre-restore-*.db). Add --yes to continue.`);
  process.exit(1);
}
const r = restore({ backupFile: resolve(positionals[0]), dbPath: config.dbPath, asideDir: config.backupDir });
console.log(`restored ${r.restored} (${r.sessions} sessions)${r.aside ? `\nprevious database kept at ${r.aside}` : ''}`);
