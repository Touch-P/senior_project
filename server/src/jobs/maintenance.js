// Maintenance jobs (brief section 5, batch line): idle session timeout, retention, backup. All idempotent and
// logged in job_runs. The scheduler (scheduler.js) runs them; `npm run job -- <name>` runs one by hand.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { closeSession } from '../services/sessions.js';
import { runJob } from './jobRuns.js';

/**
 * Close sessions nobody used for `idleMs` (no frame, no event): with items -> 'timeout', empty -> 'abandoned'.
 * Goes through closeSession, so totals, presence and pending reasons are finalized like a checkout.
 */
export function closeIdleSessions(db, hub, { idleMs = 30 * 60_000, now = Date.now() } = {}) {
  return runJob(db, 'session_timeout', () => {
    const idle = db.prepare(`SELECT s.session_id,
        MAX(s.started_at_ms, COALESCE((SELECT MAX(t_received_ms) FROM frames f WHERE f.session_id = s.session_id), 0),
            COALESCE((SELECT MAX(occurred_at_ms) FROM cart_events e WHERE e.session_id = s.session_id AND e.event_type != 'START'), 0)) AS last_ms,
        (SELECT COALESCE(SUM(qty), 0) FROM cart_item_history h WHERE h.session_id = s.session_id AND h.is_current = 1) AS items
      FROM shopping_sessions s WHERE s.status = 'active'`).all().filter((s) => now - s.last_ms > idleMs);
    for (const s of idle) closeSession(db, hub, s.session_id, { status: s.items > 0 ? 'timeout' : 'abandoned' });
    return { rows: idle.length, closed: idle.map((s) => s.session_id), message: idle.length ? `closed ${idle.length} idle session(s)` : 'nothing idle' };
  });
}

/**
 * Retention: delete frames + detections (cascade) and their JPEG files older than `days`, then VACUUM.
 * Frames still referenced by an open customer report are kept until that report is exported.
 */
export async function retention(db, { days = 30, framesDir, root, now = Date.now(), vacuum = true } = {}) {
  return runJob(db, 'retention', () => {
    const cutoff = now - days * 86_400_000;
    const old = db.prepare(`SELECT frame_id, image_path FROM frames WHERE t_received_ms < ?
                            AND frame_id NOT IN (SELECT frame_id FROM user_feedback WHERE status = 'open' AND frame_id IS NOT NULL)`).all(cutoff);
    let files = 0;
    if (old.length) {
      db.transaction(() => {
        db.exec('CREATE TEMP TABLE IF NOT EXISTS old_frames (frame_id INTEGER PRIMARY KEY)');
        db.exec('DELETE FROM old_frames');
        const ins = db.prepare('INSERT INTO old_frames VALUES (?)');
        for (const f of old) ins.run(f.frame_id);
        db.exec(`UPDATE cart_events SET frame_id = NULL WHERE frame_id IN (SELECT frame_id FROM old_frames);
                 UPDATE user_feedback SET frame_id = NULL WHERE frame_id IN (SELECT frame_id FROM old_frames);
                 DELETE FROM frames WHERE frame_id IN (SELECT frame_id FROM old_frames);
                 DROP TABLE old_frames;`);
      })();
      // image files: only inside FRAMES_DIR, never anything else
      const base = resolve(framesDir);
      for (const f of old) {
        if (!f.image_path) continue;
        const file = resolve(root, f.image_path);
        if (relative(base, file).startsWith('..')) continue;
        if (existsSync(file)) { rmSync(file); files++; }
      }
      removeEmptyDirs(base);
    }
    if (vacuum) db.exec('VACUUM');
    return { rows: old.length, files, message: `deleted ${old.length} frame(s) and ${files} image file(s) older than ${days} days` };
  });
}

function removeEmptyDirs(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      removeEmptyDirs(p);
      if (!readdirSync(p).length) rmdirSync(p);
    }
  }
}

/**
 * Online backup with better-sqlite3 (safe while the server writes), integrity-checked, newest `keep` kept.
 * @returns {Promise<{ file: string, rows: number, removed: string[] }>}
 */
export async function backup(db, { dir, keep = 7, now = new Date() } = {}) {
  return runJob(db, 'backup', async () => {
    mkdirSync(dir, { recursive: true });
    const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const file = join(dir, `smartcart-${stamp}.db`);
    await db.backup(file);
    // a backup is one self-contained file: leave WAL mode (inherited from the live db) so no -wal/-shm appear
    const check = new Database(file, { fileMustExist: true });
    check.pragma('journal_mode = DELETE');
    // the snapshot was taken while this job's row said 'running'; record it as done inside the copy
    check.prepare("UPDATE job_runs SET status = 'ok', finished_at = started_at, message = 'this backup' WHERE job = 'backup' AND status = 'running'").run();
    const ok = check.pragma('integrity_check', { simple: true });
    const sessions = check.prepare('SELECT COUNT(*) FROM shopping_sessions').pluck().get();
    check.close();
    if (ok !== 'ok') throw new Error(`backup integrity_check failed: ${ok}`);
    // keep the newest `keep` automatic backups (files this job wrote); pre-restore copies are never touched
    const mine = readdirSync(dir).filter((f) => /^smartcart-\d{8}-\d{6}\.db$/.test(f)).sort().reverse();
    const removed = mine.slice(keep);
    for (const f of removed) for (const x of ['', '-wal', '-shm']) rmSync(join(dir, f + x), { force: true });
    return { file, removed, rows: sessions, message: `${basename(file)} ok (${sessions} sessions) · removed ${removed.length} old backup(s)` };
  });
}

/**
 * Restore a backup over the database file. The current file is moved aside (never deleted) first.
 * Run with the server stopped.
 */
export function restore({ backupFile, dbPath, asideDir = join(dirname(dbPath), 'backups'), now = new Date() }) {
  if (!existsSync(backupFile)) throw new Error(`backup not found: ${backupFile}`);
  const check = new Database(backupFile, { readonly: true, fileMustExist: true });
  const ok = check.pragma('integrity_check', { simple: true });
  check.close();
  if (ok !== 'ok') throw new Error(`backup is damaged: ${ok}`);
  const aside = join(asideDir, `pre-restore-${now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}.db`);
  mkdirSync(dirname(aside), { recursive: true });
  let keptAside = null;
  if (existsSync(dbPath)) {
    // fold the WAL into the main file, then keep a full copy of the current database before replacing it
    const cur = new Database(dbPath);
    cur.pragma('wal_checkpoint(TRUNCATE)');
    cur.close();
    copyFileSync(dbPath, aside);
    keptAside = aside;
    // the -wal / -shm of the old file are empty after the checkpoint and must not be applied to the restored one
    for (const s of ['-wal', '-shm']) rmSync(dbPath + s, { force: true });
  }
  copyFileSync(backupFile, dbPath);
  const after = new Database(dbPath, { readonly: true, fileMustExist: true });
  const okAfter = after.pragma('integrity_check', { simple: true });
  const sessions = after.prepare('SELECT COUNT(*) FROM shopping_sessions').pluck().get();
  after.close();
  if (okAfter !== 'ok') throw new Error(`restored file failed integrity_check: ${okAfter}`);
  return { aside: keptAside, restored: dbPath, sessions };
}
