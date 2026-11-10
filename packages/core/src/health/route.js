import { checkHealth } from './check.js';

/**
 * Express handler for `GET /health`. Per §4.5: a degraded result is a
 * 503, deliberately not a 500 - this is the signal "the process is up
 * but not ready for traffic", which a load balancer/orchestrator
 * interprets very differently from "the app crashed".
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {string|null} [opts.version]
 * @param {() => boolean} [opts.isShuttingDown] - readiness (audit C08):
 *   once true the probe answers 503 {status:'shutting_down'} so a load
 *   balancer stops sending traffic BEFORE the process exits
 * @param {boolean} [opts.minimal=false] - unauthenticated probe: report
 *   only the status, not version/uptime (fingerprinting)
 */
export function healthHandler(db, { version = null, isShuttingDown, minimal = false } = {}) {
  return (req, res) => {
    if (isShuttingDown?.()) {
      return res.status(503).json({ status: 'shutting_down' });
    }
    const result = checkHealth(db, { version });
    const body = minimal ? { status: result.status, database: result.database } : result;
    res.status(result.status === 'ok' ? 200 : 503).json(body);
  };
}
