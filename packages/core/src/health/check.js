/**
 * `app health` / `GET /health` - "is the running process alive and
 * answering correctly" (§4.5). Must be cheap enough to call often (a
 * load balancer, systemd `ExecStartPost`, a monitoring probe every few
 * seconds): one `SELECT 1`, no integrity check, no filesystem walks -
 * that's `doctor`'s job (doctor.js), run by a human, not a probe.
 *
 * @param db - a DatabaseAdapter
 * @param {object} [opts]
 * @param {string|null} [opts.version] - app version string to echo back
 *   (deploy tooling compares this against what it just shipped)
 * @returns {{status: 'ok'|'degraded', database: 'ok'|'error', version: string|null, uptime: number}}
 */
export function checkHealth(db, { version = null } = {}) {
  let database = 'ok';
  try {
    db.get('SELECT 1 AS ok');
  } catch {
    database = 'error';
  }

  return {
    status: database === 'ok' ? 'ok' : 'degraded',
    database,
    version,
    // process.uptime() already tracks seconds since THIS process
    // started, which is exactly what "uptime" means here - no need for
    // the caller to track a separate startedAt timestamp.
    uptime: Math.floor(process.uptime()),
  };
}
