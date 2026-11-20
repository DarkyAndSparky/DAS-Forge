import { BlockList, isIP } from 'node:net';
import { ensureSettingsTable } from '../branding/company-branding.js';
import { normalizeBanValue } from './bans.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEY = 'ip_ban_policy';
export const SYSTEM_BAN_AUTHOR = 'system:auto';

/**
 * Defaults. The threshold sits above the sign-in lock of one account (5), so a person who mistypes twice never gets an address ban;
 * the term grows with every earlier ban of the same address (`baseBanMs * factor ^ earlier bans`, at most `maxBanMs`).
 */
export const IP_BAN_DEFAULTS = Object.freeze({
  enabled: true,
  maxFailures: 10,
  findTimeMs: DAY,
  baseBanMs: HOUR,
  factor: 2,
  maxBanMs: 35 * DAY,
  recidiveCount: 3,
  recidiveWindowMs: DAY,
  recidiveBanMs: 7 * DAY,
  historyRetentionMs: 35 * DAY,
  ignore: Object.freeze(['127.0.0.0/8', '::1']),
});

/** Allowed range of every number: `[min, max]`. */
export const IP_BAN_LIMITS = Object.freeze({
  maxFailures: [1, 1000],
  findTimeMs: [MIN, 30 * DAY],
  baseBanMs: [MIN, 35 * DAY],
  factor: [1, 24],
  maxBanMs: [MIN, 365 * DAY],
  recidiveCount: [2, 50],
  recidiveWindowMs: [HOUR, 30 * DAY],
  recidiveBanMs: [MIN, 365 * DAY],
  historyRetentionMs: [DAY, 400 * DAY],
});
const MAX_IGNORE = 100;

export class IpBanPolicyError extends Error {
  /** @param {string} code `<FIELD>_INVALID`, `MAX_BAN_BELOW_BASE`, `HISTORY_TOO_SHORT`, `IGNORE_INVALID`, `IGNORE_TOO_LONG` */
  constructor(code) { super(code); this.name = 'IpBanPolicyError'; this.code = code; }
}

/** One ignore-list entry: an address or `address/prefix`. @returns {{ ip: string, prefix: number|null, family: 'ipv4'|'ipv6' }|null} */
export function parseIgnoreEntry(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 64) return null;
  const [addr, pfx, extra] = s.split('/');
  if (extra !== undefined) return null;
  let ip;
  try { ip = normalizeBanValue('ip', addr); } catch { return null; }
  const family = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
  if (pfx === undefined) return { ip, prefix: null, family };
  if (!/^\d{1,3}$/.test(pfx)) return null;
  const prefix = Number(pfx);
  if (prefix > (family === 'ipv6' ? 128 : 32)) return null;
  return { ip, prefix, family };
}

const textOf = (e) => (e.prefix === null ? e.ip : `${e.ip}/${e.prefix}`);

/** Reads the ignore list from text (a line or a comma separated) or an array; throws IpBanPolicyError on a bad entry. */
export function parseIgnoreList(input) {
  const items = Array.isArray(input) ? input : String(input ?? '').split(/[\r\n,;\s]+/);
  const out = [];
  for (const it of items) {
    if (typeof it === 'string' && it.trim() === '') continue;
    const e = parseIgnoreEntry(it);
    if (!e) throw new IpBanPolicyError('IGNORE_INVALID');
    const t = textOf(e);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > MAX_IGNORE) throw new IpBanPolicyError('IGNORE_TOO_LONG');
  return out;
}

/** `[ms of 1st ban, 2nd, ...]` for the table the administrator sees. */
export function banSchedule(policy, count = 8) {
  const out = [];
  for (let n = 0; n < count; n += 1) out.push(Math.min(policy.maxBanMs, Math.round(policy.baseBanMs * policy.factor ** n)));
  return out;
}

const inRange = (k, v) => Number.isFinite(v) && v >= IP_BAN_LIMITS[k][0] && v <= IP_BAN_LIMITS[k][1];
const INTEGER_KEYS = new Set(['maxFailures', 'recidiveCount', 'factor']);

/** Values that are valid, from `layer`, over `into`; anything damaged keeps the earlier value. */
function overlay(into, layer) {
  const out = { ...into };
  if (!layer || typeof layer !== 'object') return out;
  if (typeof layer.enabled === 'boolean') out.enabled = layer.enabled;
  for (const k of Object.keys(IP_BAN_LIMITS)) if (inRange(k, layer[k]) && (INTEGER_KEYS.has(k) ? Number.isInteger(layer[k]) : true)) out[k] = layer[k];
  if (Array.isArray(layer.ignore)) { try { out.ignore = parseIgnoreList(layer.ignore); } catch { /* keep */ } }
  return out;
}

/** The two cross-field rules; a layer that breaks them is dropped whole on read. */
const consistent = (v) => v.maxBanMs >= v.baseBanMs && v.historyRetentionMs >= v.maxBanMs && v.historyRetentionMs >= v.recidiveBanMs;

/** The rules in force: defaults, then the configuration (`security.ipBan`), then the saved row (`stored`, or null); a layer that is inconsistent is dropped. */
export function resolvePolicy(config = {}, stored = null) {
  const defaults = { ...IP_BAN_DEFAULTS, ignore: [...IP_BAN_DEFAULTS.ignore] };
  const c = overlay(defaults, config);
  const base = consistent(c) ? c : defaults;
  const merged = overlay(base, stored);
  return consistent(merged) ? merged : base;
}

/** What `set(patch)` would save on top of the current rules `cur`; throws IpBanPolicyError. */
export function nextPolicy(cur, patch) {
  const next = { ...cur };
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true || patch.enabled === 'on' || patch.enabled === '1' || patch.enabled === 'true';
  for (const k of Object.keys(IP_BAN_LIMITS)) {
    if (patch[k] === undefined || patch[k] === '') continue;
    const n = typeof patch[k] === 'number' ? patch[k] : /^\d{1,12}$/.test(String(patch[k]).trim()) ? Number(patch[k]) : NaN;
    if (!inRange(k, n) || (INTEGER_KEYS.has(k) && !Number.isInteger(n))) throw new IpBanPolicyError(`${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}_INVALID`);
    next[k] = n;
  }
  if (patch.ignore !== undefined) next.ignore = parseIgnoreList(patch.ignore);
  if (next.maxBanMs < next.baseBanMs) throw new IpBanPolicyError('MAX_BAN_BELOW_BASE');
  if (next.historyRetentionMs < next.maxBanMs || next.historyRetentionMs < next.recidiveBanMs) throw new IpBanPolicyError('HISTORY_TOO_SHORT');
  return next;
}

let listCache = { key: '', list: new BlockList() };
function blockList(ignore) {
  const key = ignore.join('|');
  if (listCache.key === key) return listCache.list;
  const list = new BlockList();
  for (const t of ignore) {
    const e = parseIgnoreEntry(t);
    if (!e) continue;
    if (e.prefix === null) list.addAddress(e.ip, e.family); else list.addSubnet(e.ip, e.prefix, e.family);
  }
  listCache = { key, list };
  return list;
}

/** True when `ip` is on the policy's ignore list. */
export function isIgnoredBy(ip, policy) {
  let v;
  try { v = normalizeBanValue('ip', ip); } catch { return false; }
  return blockList(policy.ignore).check(v, isIP(v) === 6 ? 'ipv6' : 'ipv4');
}

/** The term of the next automatic ban: grows with the earlier bans, and at least `recidiveBanMs` for a repeat offender. */
export function banTerm(p, { count, earlier, recent }) {
  let durationMs = Math.min(p.maxBanMs, Math.round(p.baseBanMs * p.factor ** Math.min(earlier, 60)));
  let why = `${count} failed sign-ins`;
  if (recent + 1 >= p.recidiveCount) { durationMs = Math.max(durationMs, p.recidiveBanMs); why += `, repeat offender (${recent + 1} bans in the window)`; }
  return { durationMs, why };
}

export { KEY as IP_BAN_SETTINGS_KEY };

/**
 * Automatic ban of an address after repeated failed sign-ins, kept in the database (a restart does not free the attacker).
 * Failures are counted inside `findTimeMs`; at `maxFailures` the address is banned (`bans.ban`) for a term that grows with the
 * number of its earlier automatic bans; `recidiveCount` bans inside `recidiveWindowMs` raise the term to at least `recidiveBanMs`.
 * Addresses on the ignore list are never banned. The values are changed by an administrator without a restart (`set`), kept in
 * `app_settings`; `config` (the `security.ipBan` section) gives the starting values.
 *
 * @param {{ db: object, bans: object, config?: object, now?: () => number }} o
 */
export function createIpBanPolicy({ db, bans, config = {}, now = () => Date.now() }) {
  if (!db) throw new TypeError('createIpBanPolicy: db is required');
  if (!bans || typeof bans.ban !== 'function') throw new TypeError('createIpBanPolicy: bans (security.createBans) is required');
  db.exec(`CREATE TABLE IF NOT EXISTS security_ip_failures (ip TEXT NOT NULL, at INTEGER NOT NULL)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_security_ip_failures ON security_ip_failures (ip, at)`);

  function stored() {
    try {
      ensureSettingsTable(db);
      const row = db.get(`SELECT value FROM app_settings WHERE key = ?`, [KEY]);
      return row ? JSON.parse(row.value) : null;
    } catch { return null; }
  }

  /** @returns {typeof IP_BAN_DEFAULTS} */
  function get() {
    return resolvePolicy(config, stored());
  }

  /** Validates and saves (partial values are merged into the current ones). @returns {object} the new values */
  function set(patch) {
    const next = nextPolicy(get(), patch);
    ensureSettingsTable(db);
    db.run(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [KEY, JSON.stringify(next)]);
    return get();
  }

  /** Forgets the saved values; the configuration (or the defaults) applies again. */
  function reset() {
    ensureSettingsTable(db);
    db.run(`DELETE FROM app_settings WHERE key = ?`, [KEY]);
    return get();
  }

  /** True when the address is on the ignore list (never banned automatically). */
  function isIgnored(ip, policy = get()) {
    return isIgnoredBy(ip, policy);
  }

  /**
   * Counts one failed sign-in of an address. Never throws: a counting problem must not break the sign-in page.
   * @param {string} ip
   * @param {{ ctx?: object }} [o]
   * @returns {{ banned: boolean, reason?: 'disabled'|'ignored'|'invalid'|'already'|'counted', count?: number, durationMs?: number }}
   */
  function recordFailure(ip, { ctx = {} } = {}) {
    try {
      const p = get();
      if (!p.enabled) return { banned: false, reason: 'disabled' };
      let v;
      try { v = normalizeBanValue('ip', ip); } catch { return { banned: false, reason: 'invalid' }; }
      if (isIgnored(v, p)) return { banned: false, reason: 'ignored' };
      if (bans.check({ ip: v })) return { banned: false, reason: 'already' };
      const t = now();
      db.run(`INSERT INTO security_ip_failures (ip, at) VALUES (?, ?)`, [v, t]);
      db.run(`DELETE FROM security_ip_failures WHERE ip = ? AND at < ?`, [v, t - p.findTimeMs]);
      const count = db.get(`SELECT COUNT(*) AS n FROM security_ip_failures WHERE ip = ? AND at >= ?`, [v, t - p.findTimeMs]).n;
      if (count < p.maxFailures) return { banned: false, reason: 'counted', count };
      const earlier = db.get(`SELECT COUNT(*) AS n FROM security_bans WHERE kind = 'ip' AND value = ? AND created_by = ? AND created_at >= ?`,
        [v, SYSTEM_BAN_AUTHOR, new Date(t - p.historyRetentionMs).toISOString()]).n;
      const recent = db.get(`SELECT COUNT(*) AS n FROM security_bans WHERE kind = 'ip' AND value = ? AND created_by = ? AND created_at >= ?`,
        [v, SYSTEM_BAN_AUTHOR, new Date(t - p.recidiveWindowMs).toISOString()]).n;
      const { durationMs, why } = banTerm(p, { count, earlier, recent });
      const r = bans.ban({ kind: 'ip', value: v, reason: `auto: ${why}`, by: SYSTEM_BAN_AUTHOR, durationMs, ctx });
      db.run(`DELETE FROM security_ip_failures WHERE ip = ?`, [v]);
      return { banned: !r.already, reason: r.already ? 'already' : undefined, count, durationMs };
    } catch {
      return { banned: false, reason: 'invalid' };
    }
  }

  /** Drops counters nobody needs any more; call from a scheduled job. @returns {number} rows removed */
  function purge() {
    return Number(db.run(`DELETE FROM security_ip_failures WHERE at < ?`, [now() - IP_BAN_LIMITS.findTimeMs[1]]).changes);
  }

  return { get, set, reset, isIgnored, recordFailure, purge, schedule: (n) => banSchedule(get(), n), defaults: IP_BAN_DEFAULTS, limits: IP_BAN_LIMITS };
}
