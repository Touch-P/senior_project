// Applies db/migrations/*.sql in order and records them in schema_migrations.
// Usage: npm run db:init
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { openDb, supportsTrigram } from './connection.js';

const log = logger.child({ mod: 'migrate' });

/** Capabilities a migration can require via a `-- requires: <name>` header line. */
const CAPABILITIES = { fts5_trigram: supportsTrigram };

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} [dir]
 * @returns {{ applied: string[], skipped: string[] }}
 */
export function migrate(db, dir = config.migrationsDir) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    checksum   TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','skipped')),
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const done = new Map(db.prepare('SELECT version, checksum, status FROM schema_migrations').all().map((r) => [r.version, r]));
  const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const result = { applied: [], skipped: [] };

  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const prev = done.get(file);
    const required = [...sql.matchAll(/^--\s*requires:\s*(\w+)/gm)].map((m) => m[1]);
    const missing = required.filter((cap) => !(CAPABILITIES[cap] ?? (() => false))(db));

    if (prev?.status === 'applied') {
      if (prev.checksum !== checksum) {
        throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead.`);
      }
      continue;
    }
    if (missing.length) {
      if (!prev) {
        db.prepare("INSERT INTO schema_migrations (version, checksum, status) VALUES (?, ?, 'skipped')").run(file, checksum);
        log.warn({ file, missing }, 'migration skipped: SQLite capability not available');
      }
      result.skipped.push(file);
      continue;
    }
    db.transaction(() => {
      db.exec(sql);
      db.prepare(`INSERT INTO schema_migrations (version, checksum, status) VALUES (?, ?, 'applied')
                  ON CONFLICT (version) DO UPDATE SET checksum = excluded.checksum, status = 'applied',
                  applied_at = CURRENT_TIMESTAMP`).run(file, checksum);
    })();
    result.applied.push(file);
    log.info({ file }, 'migration applied');
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  try {
    const { applied, skipped } = migrate(db);
    log.info({ db: config.dbPath, applied: applied.length, skipped }, 'database is up to date');
  } finally {
    db.close();
  }
}
