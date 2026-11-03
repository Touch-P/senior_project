import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

/**
 * Open a SQLite connection with the pragmas every connection must use.
 * @param {string} [path] database file, defaults to DB_PATH; ':memory:' for tests
 * @returns {import('better-sqlite3').Database}
 */
export function openDb(path = config.dbPath) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * Whether the bundled SQLite supports FTS5 with the trigram tokenizer (SQLite >= 3.34).
 * @param {import('better-sqlite3').Database} db
 */
export function supportsTrigram(db) {
  try {
    db.exec("CREATE VIRTUAL TABLE temp.__trigram_probe USING fts5(x, tokenize='trigram'); DROP TABLE temp.__trigram_probe;");
    return true;
  } catch {
    return false;
  }
}

/** Current time in epoch milliseconds (server clock). */
export const nowMs = () => Date.now();
