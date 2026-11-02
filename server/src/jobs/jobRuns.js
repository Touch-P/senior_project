/**
 * Run a batch job and record it in job_runs. The job function returns
 * `{ rows, message }` (both optional); a thrown error marks the run as 'error'.
 * @template T
 * @param {import('better-sqlite3').Database} db
 * @param {string} job
 * @param {() => Promise<{rows?: number, message?: string} & T> | ({rows?: number, message?: string} & T)} fn
 * @returns {Promise<T & {rows?: number, message?: string}>}
 */
export async function runJob(db, job, fn) {
  const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const { lastInsertRowid: runId } = db
    .prepare("INSERT INTO job_runs (job, started_at, status) VALUES (?, ?, 'running')")
    .run(job, now());
  const finish = db.prepare('UPDATE job_runs SET finished_at = ?, status = ?, rows_affected = ?, message = ? WHERE run_id = ?');
  try {
    const out = (await fn()) ?? {};
    finish.run(now(), 'ok', out.rows ?? null, out.message ?? null, runId);
    return out;
  } catch (err) {
    finish.run(now(), 'error', null, String(err?.message ?? err).slice(0, 1000), runId);
    throw err;
  }
}
