import { asyncDb } from '../database/async.js';
import { logAsync } from '../audit/async.js';
import { sendError } from '../http/respond.js';
import { destroyUserSessionsAsync } from '../auth/async.js';
import { ensureSettingsTableAsync } from '../branding/company-branding.js';
import { normalizeBanValue, activeSql, rowOut, cidrHit, activeRangesSql } from './bans.js';
import {
  SYSTEM_BAN_AUTHOR, IP_BAN_DEFAULTS, IP_BAN_LIMITS, IP_BAN_SETTINGS_KEY, resolvePolicy, nextPolicy, isIgnoredBy, banTerm, banSchedule,
} from './ip-ban.js';

/**
 * Bans and the automatic IP ban over `asyncDb` (ADR-0010, step 8). Same tables, rules, audit lines and results as bans.js and ip-ban.js;
 * the checks that run on every request (`check`, `middleware`) keep their in-memory cache, so a request costs a query only when the
 * cache entry has expired. Methods return Promises; the tables are created on first use.
 */
export async function ensureBansTableAsync(db) {
  const a = asyncDb(db);
  await a.exec(`CREATE TABLE IF NOT EXISTS security_bans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('ip','user')),
    value TEXT NOT NULL,
    reason TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    lifted_at TEXT,
    lifted_by TEXT
  )`);
  await a.exec('CREATE INDEX IF NOT EXISTS idx_security_bans_lookup ON security_bans (kind, value)');
}

export function createBansAsync(db, { cacheMs = 5000, now = () => Date.now() } = {}) {
  const a = asyncDb(db);
  let readyPromise = null;
  const ready = () => (readyPromise ??= ensureBansTableAsync(a).catch((err) => { readyPromise = null; throw err; }));
  let cache = new Map();
  let ranges = null;
  const iso = () => new Date(now()).toISOString();
  const invalidate = () => { cache = new Map(); ranges = null; };

  const findActive = (conn, kind, value) =>
    conn.get(`SELECT * FROM security_bans WHERE kind = ? AND value = ? AND ${activeSql} ORDER BY id DESC LIMIT 1`, [kind, value, iso()]);

  async function ban({ kind, value, reason = null, by = null, durationMs = null, ctx = {} }) {
    await ready();
    const v = normalizeBanValue(kind, value, { range: true });
    const t = now();
    const expires = durationMs ? new Date(t + durationMs).toISOString() : null;
    // check, insert, end the sessions and write the audit line together (G-04)
    const done = await a.transaction(async (tx) => {
      const existing = await findActive(tx, kind, v);
      if (existing) return { already: existing };
      const info = await tx.run(
        'INSERT INTO security_bans (kind, value, reason, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        [kind, v, reason ? String(reason).slice(0, 500) : null, by, new Date(t).toISOString(), expires]
      );
      const id = Number(info.lastInsertRowid);
      let sessions = 0;
      if (kind === 'user') {
        const u = await tx.get('SELECT id FROM users WHERE username = ?', [v]);
        if (u) sessions = await destroyUserSessionsAsync(tx, u.id);
      }
      await logAsync(tx, { ...ctx, actor: by ?? ctx.actor ?? null, action: 'security.ban', entity: 'ban', entityId: id, meta: { kind, value: v, reason, expiresAt: expires, sessionsEnded: sessions } });
      return { id, sessions };
    }, { mode: 'immediate' });
    if (done.already) return { ...rowOut(done.already), already: true };
    invalidate();
    return { id: done.id, kind, value: v, reason, createdBy: by, expiresAt: expires, already: false, sessionsEnded: done.sessions };
  }

  async function lift({ id, kind, value, by = null, ctx = {} }) {
    await ready();
    const rows = id !== undefined
      ? await a.all(`SELECT * FROM security_bans WHERE id = ? AND ${activeSql}`, [Number(id), iso()])
      : await a.all(`SELECT * FROM security_bans WHERE kind = ? AND value = ? AND ${activeSql}`, [kind, normalizeBanValue(kind, value, { range: true }), iso()]);
    await a.transaction(async (tx) => {
      for (const r of rows) {
        await tx.run('UPDATE security_bans SET lifted_at = ?, lifted_by = ? WHERE id = ?', [iso(), by, r.id]);
        await logAsync(tx, { ...ctx, actor: by ?? ctx.actor ?? null, action: 'security.unban', entity: 'ban', entityId: r.id, meta: { kind: r.kind, value: r.value } });
      }
    }, { mode: 'immediate' });
    invalidate();
    return rows.length;
  }

  async function list({ active = true, limit = 200, offset = 0 } = {}) {
    await ready();
    const off = Math.max(0, Math.trunc(Number(offset)) || 0);
    const rows = active
      ? await a.all(`SELECT * FROM security_bans WHERE ${activeSql} ORDER BY id DESC LIMIT ? OFFSET ?`, [iso(), limit, off])
      : await a.all('SELECT * FROM security_bans ORDER BY id DESC LIMIT ? OFFSET ?', [limit, off]);
    return rows.map(rowOut);
  }

  async function count({ active = true } = {}) {
    await ready();
    return active ? (await a.get(`SELECT COUNT(*) AS n FROM security_bans WHERE ${activeSql}`, [iso()])).n : (await a.get('SELECT COUNT(*) AS n FROM security_bans')).n;
  }

  /** Cached check used on every request; `ip`/`username` are both optional. */
  async function check({ ip, username } = {}) {
    for (const [kind, raw] of [['ip', ip], ['user', username]]) {
      if (!raw) continue;
      let v;
      try { v = normalizeBanValue(kind, raw); } catch { continue; }
      const key = `${kind}|${v}`;
      let c = cache.get(key);
      if (!c || now() - c.at > cacheMs) {
        await ready();
        c = { at: now(), ban: (await findActive(a, kind, v)) ?? null };
        if (cache.size > 5000) cache = new Map();
        cache.set(key, c);
      }
      if (c.ban) return rowOut(c.ban);
    }
    if (ip) {
      if (!ranges || now() - ranges.at > cacheMs) {
        await ready();
        ranges = { at: now(), rows: await a.all(activeRangesSql, [iso()]) };
      }
      const hit = cidrHit(ranges.rows, ip);
      if (hit) return rowOut(hit);
    }
    return null;
  }

  /** Express middleware; mount after attachUser(). A failing lookup passes the error on (never lets the request through unchecked silently). */
  function middleware({ onBlocked } = {}) {
    return async (req, res, next) => {
      try {
        const hit = await check({ ip: req.ip, username: req.user?.username });
        if (!hit) return next();
        onBlocked?.(req, hit);
        return sendError(req, res, 403, { error: 'BANNED', fields: [] });
      } catch (err) {
        return next(err);
      }
    };
  }

  async function purge({ keepDays = 180 } = {}) {
    await ready();
    const cutoff = new Date(now() - keepDays * 86400_000).toISOString();
    return Number((await a.run('DELETE FROM security_bans WHERE (lifted_at IS NOT NULL AND lifted_at < ?) OR (expires_at IS NOT NULL AND expires_at < ?)', [cutoff, cutoff])).changes);
  }

  return { ban, lift, list, count, check, middleware, purge, invalidate };
}

/** `createIpBanPolicy` over `asyncDb`; `bans` is a `createBansAsync` object. */
export function createIpBanPolicyAsync({ db, bans, config = {}, now = () => Date.now() }) {
  if (!db) throw new TypeError('createIpBanPolicyAsync: db is required');
  if (!bans || typeof bans.ban !== 'function') throw new TypeError('createIpBanPolicyAsync: bans (security.createBansAsync) is required');
  const a = asyncDb(db);
  let readyPromise = null;
  const ready = () => (readyPromise ??= (async () => {
    await a.exec('CREATE TABLE IF NOT EXISTS security_ip_failures (ip TEXT NOT NULL, at INTEGER NOT NULL)');
    await a.exec('CREATE INDEX IF NOT EXISTS idx_security_ip_failures ON security_ip_failures (ip, at)');
  })().catch((err) => { readyPromise = null; throw err; }));

  async function stored() {
    try {
      await ensureSettingsTableAsync(a);
      const row = await a.get('SELECT value FROM app_settings WHERE key = ?', [IP_BAN_SETTINGS_KEY]);
      return row ? JSON.parse(row.value) : null;
    } catch { return null; }
  }
  const get = async () => resolvePolicy(config, await stored());

  async function set(patch) {
    const next = nextPolicy(await get(), patch);
    await ensureSettingsTableAsync(a);
    await a.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [IP_BAN_SETTINGS_KEY, JSON.stringify(next)]);
    return get();
  }
  async function reset() {
    await ensureSettingsTableAsync(a);
    await a.run('DELETE FROM app_settings WHERE key = ?', [IP_BAN_SETTINGS_KEY]);
    return get();
  }
  const isIgnored = async (ip, policy) => isIgnoredBy(ip, policy ?? (await get()));

  /** Counts one failed sign-in of an address. Never rejects: a counting problem must not break the sign-in page. */
  async function recordFailure(ip, { ctx = {} } = {}) {
    try {
      await ready();
      const p = await get();
      if (!p.enabled) return { banned: false, reason: 'disabled' };
      let v;
      try { v = normalizeBanValue('ip', ip); } catch { return { banned: false, reason: 'invalid' }; }
      if (isIgnoredBy(v, p)) return { banned: false, reason: 'ignored' };
      if (await bans.check({ ip: v })) return { banned: false, reason: 'already' };
      const t = now();
      const count = await a.transaction(async (tx) => {
        await tx.run('INSERT INTO security_ip_failures (ip, at) VALUES (?, ?)', [v, t]);
        await tx.run('DELETE FROM security_ip_failures WHERE ip = ? AND at < ?', [v, t - p.findTimeMs]);
        return (await tx.get('SELECT COUNT(*) AS n FROM security_ip_failures WHERE ip = ? AND at >= ?', [v, t - p.findTimeMs])).n;
      });
      if (count < p.maxFailures) return { banned: false, reason: 'counted', count };
      const since = (ms) => new Date(t - ms).toISOString();
      const q = `SELECT COUNT(*) AS n FROM security_bans WHERE kind = 'ip' AND value = ? AND created_by = ? AND created_at >= ?`;
      const earlier = (await a.get(q, [v, SYSTEM_BAN_AUTHOR, since(p.historyRetentionMs)])).n;
      const recent = (await a.get(q, [v, SYSTEM_BAN_AUTHOR, since(p.recidiveWindowMs)])).n;
      const { durationMs, why } = banTerm(p, { count, earlier, recent });
      const r = await bans.ban({ kind: 'ip', value: v, reason: `auto: ${why}`, by: SYSTEM_BAN_AUTHOR, durationMs, ctx });
      await a.run('DELETE FROM security_ip_failures WHERE ip = ?', [v]);
      return { banned: !r.already, reason: r.already ? 'already' : undefined, count, durationMs };
    } catch {
      return { banned: false, reason: 'invalid' };
    }
  }

  async function purge() {
    await ready();
    return Number((await a.run('DELETE FROM security_ip_failures WHERE at < ?', [now() - IP_BAN_LIMITS.findTimeMs[1]])).changes);
  }

  return { get, set, reset, isIgnored, recordFailure, purge, schedule: async (n) => banSchedule(await get(), n), defaults: IP_BAN_DEFAULTS, limits: IP_BAN_LIMITS };
}
