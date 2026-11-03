// Batch schedule (brief section 5) in the server process, store time zone (default Asia/Bangkok):
//   every minute   close idle sessions (SESSION_IDLE_MS) -> timeout / abandoned
//   02:00 daily    analytics for yesterday + today
//   02:30 daily    backup (keep BACKUP_KEEP)
//   03:00 Sunday   retention (RETENTION_DAYS) + VACUUM
//   on checkout    analytics of that day (cheap, keeps the dashboard tables current)
import { schedule } from 'node-cron';
import { runAnalytics } from './analytics.js';
import { backup, closeIdleSessions, retention } from './maintenance.js';
import { localDay } from './time.js';

/**
 * @param {{ db: import('better-sqlite3').Database, hub: any, cfg: any, log: import('pino').Logger }} deps
 */
export function startScheduler({ db, hub, cfg, log }) {
  const tz = db.prepare('SELECT timezone FROM stores ORDER BY store_id LIMIT 1').pluck().get() ?? 'Asia/Bangkok';
  const safe = (name, fn) => async () => {
    try { await fn(); } catch (err) { log.error({ job: name, err: err.message }, 'job failed (recorded in job_runs)'); }
  };
  const opts = (name) => ({ timezone: tz, name, noOverlap: true });
  const tasks = [
    schedule('* * * * *', safe('session_timeout', () => closeIdleSessions(db, hub, { idleMs: cfg.SESSION_IDLE_MS })), opts('session_timeout')),
    schedule('0 2 * * *', safe('analytics', () => runAnalytics(db, { tz })), opts('analytics')),
    schedule('30 2 * * *', safe('backup', () => backup(db, { dir: cfg.backupDir, keep: cfg.BACKUP_KEEP })), opts('backup')),
    schedule('0 3 * * 0', safe('retention', () => retention(db, { days: cfg.RETENTION_DAYS, framesDir: cfg.framesDir, root: cfg.ROOT })), opts('retention')),
  ];
  // after each checkout, refresh today's summaries (debounced: several checkouts in a row run once)
  let pending = null;
  const onClosed = () => {
    clearTimeout(pending);
    pending = setTimeout(safe('analytics', () => runAnalytics(db, { days: [localDay(Date.now(), tz)], tz })), 2000);
    pending.unref?.();
  };
  hub.events?.on('session_closed', onClosed);
  log.info({ tz, jobs: ['session_timeout', 'analytics 02:00', 'backup 02:30', 'retention Sun 03:00'] }, 'batch jobs scheduled');
  return {
    stop() {
      clearTimeout(pending);
      hub.events?.off('session_closed', onClosed);
      for (const t of tasks) t.stop();
    },
  };
}
