/**
 * Summary of the audit log for a period (audit chapter 3, stage C): the numbers an administrator looks for first,
 * a per-day series for a chart, and the addresses and names with the most failed sign-ins.
 * Reads only; every query is bound with `?` and limited.
 */
import { normalizeTimestamp } from './query.js';


/**
 * @param {object} db
 * @param {{since: string, until?: string}} period - ISO dates
 * @returns {{since: string, until: string, totals: object, perDay: Array, topFailedIps: Array, topFailedLogins: Array, topActions: Array}}
 */
export function summarize(db, { since, until = new Date().toISOString() } = {}) {
  const s = normalizeTimestamp(since, 'since');
  const u = normalizeTimestamp(until, 'until');
  const n = (sql, params = []) => Number(db.get(sql, [s, u, ...params])?.n ?? 0);

  const totals = {
    events: n('SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ?'),
    logins: n("SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? AND action = 'auth.login' AND result = 'success'"),
    loginFailures: n("SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? AND action = 'auth.login' AND result <> 'success'"),
    lockouts: n("SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? AND action = 'auth.lockout'"),
    newDevices: n("SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? AND action = 'auth.login.new_device'"),
    adminActions: n("SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? AND action LIKE 'admin.%'"),
    failures: n("SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? AND result <> 'success'"),
    activeUsers: n("SELECT COUNT(DISTINCT actor) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? AND action = 'auth.login' AND result = 'success' AND actor IS NOT NULL"),
  };

  const perDay = db.all(
    `SELECT substr(created_at, 1, 10) AS day,
            SUM(CASE WHEN action = 'auth.login' AND result = 'success' THEN 1 ELSE 0 END) AS logins,
            SUM(CASE WHEN action = 'auth.login' AND result <> 'success' THEN 1 ELSE 0 END) AS failures,
            COUNT(*) AS events
     FROM audit_log WHERE created_at >= ? AND created_at <= ? GROUP BY day ORDER BY day LIMIT 400`,
    [s, u],
  ).map((r) => ({ day: r.day, logins: Number(r.logins), failures: Number(r.failures), events: Number(r.events) }));

  const topFailedIps = db.all(
    `SELECT ip AS key, COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? AND action = 'auth.login' AND result <> 'success' AND ip IS NOT NULL GROUP BY ip ORDER BY n DESC, ip LIMIT 10`,
    [s, u],
  ).map((r) => ({ key: r.key, count: Number(r.n) }));

  const topFailedLogins = db.all(
    `SELECT actor AS key, COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? AND action = 'auth.login' AND result <> 'success' AND actor IS NOT NULL GROUP BY actor ORDER BY n DESC, actor LIMIT 10`,
    [s, u],
  ).map((r) => ({ key: r.key, count: Number(r.n) }));

  const topActions = db.all(
    `SELECT action AS key, COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? GROUP BY action ORDER BY n DESC, action LIMIT 10`,
    [s, u],
  ).map((r) => ({ key: r.key, count: Number(r.n) }));

  return { since: s, until: u, totals, perDay, topFailedIps, topFailedLogins, topActions };
}
