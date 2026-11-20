/**
 * Summary of the audit log for a period (audit chapter 3, stage C): the numbers an administrator looks for first,
 * a per-day series for a chart, and the addresses and names with the most failed sign-ins.
 * Reads only; every query is bound with `?` and limited.
 */
import { normalizeTimestamp } from './query.js';
import { asyncDb } from '../database/async.js';


const TOTALS = [
  ['events', 'SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ?'],
  ['logins', "SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? AND action = 'auth.login' AND result = 'success'"],
  ['loginFailures', "SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? AND action = 'auth.login' AND result <> 'success'"],
  ['lockouts', "SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? AND action = 'auth.lockout'"],
  ['newDevices', "SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? AND action = 'auth.login.new_device'"],
  ['adminActions', "SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? AND action LIKE 'admin.%'"],
  ['failures', "SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? AND result <> 'success'"],
  ['activeUsers', "SELECT COUNT(DISTINCT actor) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? AND action = 'auth.login' AND result = 'success' AND actor IS NOT NULL"],
];
const PER_DAY_SQL = `SELECT substr(created_at, 1, 10) AS day,
            SUM(CASE WHEN action = 'auth.login' AND result = 'success' THEN 1 ELSE 0 END) AS logins,
            SUM(CASE WHEN action = 'auth.login' AND result <> 'success' THEN 1 ELSE 0 END) AS failures,
            COUNT(*) AS events
     FROM audit_log WHERE created_at >= ? AND created_at <= ? GROUP BY day ORDER BY day LIMIT 400`;
const TOP_IPS_SQL = `SELECT ip AS key, COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? AND action = 'auth.login' AND result <> 'success' AND ip IS NOT NULL GROUP BY ip ORDER BY n DESC, ip LIMIT 10`;
const TOP_LOGINS_SQL = `SELECT actor AS key, COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? AND action = 'auth.login' AND result <> 'success' AND actor IS NOT NULL GROUP BY actor ORDER BY n DESC, actor LIMIT 10`;
const TOP_ACTIONS_SQL = `SELECT action AS key, COUNT(*) AS n FROM audit_log WHERE created_at >= ? AND created_at <= ? GROUP BY action ORDER BY n DESC, action LIMIT 10`;
const asDay = (r) => ({ day: r.day, logins: Number(r.logins), failures: Number(r.failures), events: Number(r.events) });
const asKey = (r) => ({ key: r.key, count: Number(r.n) });

const period = (since, until) => [normalizeTimestamp(since, 'since'), normalizeTimestamp(until, 'until')];

/**
 * @param {object} db
 * @param {{since: string, until?: string}} period - ISO dates
 * @returns {{since: string, until: string, totals: object, perDay: Array, topFailedIps: Array, topFailedLogins: Array, topActions: Array}}
 */
export function summarize(db, { since, until = new Date().toISOString() } = {}) {
  const [s, u] = period(since, until);
  const totals = Object.fromEntries(TOTALS.map(([k, sql]) => [k, Number(db.get(sql, [s, u])?.n ?? 0)]));
  return {
    since: s, until: u, totals,
    perDay: db.all(PER_DAY_SQL, [s, u]).map(asDay),
    topFailedIps: db.all(TOP_IPS_SQL, [s, u]).map(asKey),
    topFailedLogins: db.all(TOP_LOGINS_SQL, [s, u]).map(asKey),
    topActions: db.all(TOP_ACTIONS_SQL, [s, u]).map(asKey),
  };
}

/** `summarize` over `asyncDb`. */
export async function summarizeAsync(db, { since, until = new Date().toISOString() } = {}) {
  const a = asyncDb(db);
  const [s, u] = period(since, until);
  const totals = {};
  for (const [k, sql] of TOTALS) totals[k] = Number((await a.get(sql, [s, u]))?.n ?? 0);
  return {
    since: s, until: u, totals,
    perDay: (await a.all(PER_DAY_SQL, [s, u])).map(asDay),
    topFailedIps: (await a.all(TOP_IPS_SQL, [s, u])).map(asKey),
    topFailedLogins: (await a.all(TOP_LOGINS_SQL, [s, u])).map(asKey),
    topActions: (await a.all(TOP_ACTIONS_SQL, [s, u])).map(asKey),
  };
}
