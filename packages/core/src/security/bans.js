import { atomic } from '../database/atomic.js';
import { isAsyncOnly } from '../database/async.js';
import { isIP, BlockList } from 'node:net';
import { log } from '../audit/log.js';
import { sendError } from '../http/respond.js';
import { destroyUserSessions } from '../auth/sessions.js';

/**
 * Bans (admin section, "Безопасность"): an IP address or a username can be banned, optionally for a
 * limited time. Bans are rows in `security_bans` (never deleted by lifting - `lifted_at` is set, so the
 * history stays), every ban/lift is written to the audit log, and banning a user also ends their sessions.
 */
export function ensureBansTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS security_bans (
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_security_bans_lookup ON security_bans (kind, value)`);
}

/** "30m", "2h", "7d", "45s" -> ms; null/'' -> null (permanent). */
export function parseDuration(text) {
  if (text == null || text === '') return null;
  const m = /^(\d{1,6})\s*([smhd])$/i.exec(String(text).trim());
  if (!m) throw new TypeError(`bans: invalid duration "${text}" (use 30m, 2h, 7d)`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase()];
}

/** "10.0.0.0/24" / "2001:db8::/32" -> `{ addr, prefix, family }`, or null when it is not a network. */
export function parseCidr(text) {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const addr = m[1].toLowerCase();
  const family = isIP(addr);
  const prefix = Number(m[2]);
  if (!family || prefix > (family === 4 ? 32 : 128)) return null;
  return { addr, prefix, family: family === 4 ? 'ipv4' : 'ipv6' };
}

/** Is `ip` inside one of the banned networks (rows of `security_bans` whose value is a CIDR)? Uses node:net BlockList. */
export function cidrHit(rows, ip) {
  const plain = String(ip ?? '').toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  const family = isIP(plain);
  if (!family) return null;
  for (const r of rows) {
    const c = parseCidr(r.value);
    if (!c || c.family !== (family === 4 ? 'ipv4' : 'ipv6')) continue;
    const list = new BlockList();
    list.addSubnet(c.addr, c.prefix, c.family);
    if (list.check(plain, c.family)) return r;
  }
  return null;
}

/** Is `ip` inside one of `nets` (each "10.0.0.0/24", "2001:db8::/32" or a single address)? An unreadable address is never inside. */
export function ipInNets(nets, ip) {
  const rows = (nets ?? []).map((n) => ({ value: String(n).includes('/') ? String(n) : `${n}/${isIP(String(n)) === 6 ? 128 : 32}` }));
  return cidrHit(rows, ip) !== null;
}

export const activeRangesSql = `SELECT * FROM security_bans WHERE kind = 'ip' AND value LIKE '%/%' AND ${'lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)'} ORDER BY id DESC LIMIT 500`;

export function normalizeBanValue(kind, value, { range = false } = {}) {
  const v = String(value ?? '').trim();
  if (kind === 'ip') {
    if (range && v.includes('/')) {
      const c = parseCidr(v);
      if (!c) throw new TypeError(`bans: not a network (use 10.0.0.0/24): ${v}`);
      return `${c.addr}/${c.prefix}`;
    }
    // IPv4-mapped IPv6 ("::ffff:1.2.3.4") is the same client as the plain IPv4
    const plain = v.toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
    if (!isIP(plain)) throw new TypeError(`bans: not an IP address: ${v}`);
    return plain;
  }
  if (kind === 'user') {
    if (!v || v.length > 64 || /[\u0000-\u001f]/.test(v)) throw new TypeError('bans: invalid username');
    return v;
  }
  throw new TypeError(`bans: unknown kind "${kind}" (ip|user)`);
}

export const activeSql = `lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`;

export function createBans(db, { cacheMs = 5000, now = () => Date.now() } = {}) {
  if (!isAsyncOnly(db)) ensureBansTable(db);
  /** @type {Map<string, {at:number, hit:boolean}>} */
  let cache = new Map();
  let ranges = null; // active banned networks, refreshed every cacheMs

  const iso = () => new Date(now()).toISOString();
  const invalidate = () => { cache = new Map(); ranges = null; };

  function findActive(kind, value) {
    return db.get(`SELECT * FROM security_bans WHERE kind = ? AND value = ? AND ${activeSql} ORDER BY id DESC LIMIT 1`, [kind, value, iso()]);
  }

  function ban({ kind, value, reason = null, by = null, durationMs = null, ctx = {} }) {
    const v = normalizeBanValue(kind, value, { range: true });
    const t = now();
    const expires = durationMs ? new Date(t + durationMs).toISOString() : null;
    // check, insert, end the sessions and write the audit line together (G-04): two bans of the same address at the same
    // moment give one ban, and a crash cannot leave a ban without its audit line or its ended sessions
    const done = atomic(db, () => {
    const existing = findActive(kind, v);
    if (existing) return { already: existing };
    const info = db.run(
      `INSERT INTO security_bans (kind, value, reason, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [kind, v, reason ? String(reason).slice(0, 500) : null, by, new Date(t).toISOString(), expires]
    );
    const id = Number(info.lastInsertRowid);
    let sessions = 0;
    if (kind === 'user') {
      const u = db.get(`SELECT id FROM users WHERE username = ?`, [v]);
      if (u) sessions = destroyUserSessions(db, u.id);
    }
    log(db, { ...ctx, actor: by ?? ctx.actor ?? null, action: 'security.ban', entity: 'ban', entityId: id, meta: { kind, value: v, reason, expiresAt: expires, sessionsEnded: sessions } });
    return { id, sessions };
    });
    if (done.already) return { ...rowOut(done.already), already: true };
    invalidate();
    return { id: done.id, kind, value: v, reason, createdBy: by, expiresAt: expires, already: false, sessionsEnded: done.sessions };
  }

  /** Lift by id, or every active ban of (kind, value). Returns how many were lifted. */
  function lift({ id, kind, value, by = null, ctx = {} }) {
    let rows;
    if (id !== undefined) rows = db.all(`SELECT * FROM security_bans WHERE id = ? AND ${activeSql}`, [Number(id), iso()]);
    else rows = db.all(`SELECT * FROM security_bans WHERE kind = ? AND value = ? AND ${activeSql}`, [kind, normalizeBanValue(kind, value, { range: true }), iso()]);
    atomic(db, () => { // each lifted ban and its audit line together
      for (const r of rows) {
        db.run(`UPDATE security_bans SET lifted_at = ?, lifted_by = ? WHERE id = ?`, [iso(), by, r.id]);
        log(db, { ...ctx, actor: by ?? ctx.actor ?? null, action: 'security.unban', entity: 'ban', entityId: r.id, meta: { kind: r.kind, value: r.value } });
      }
    });
    invalidate();
    return rows.length;
  }

  function list({ active = true, limit = 200, offset = 0 } = {}) {
    const off = Math.max(0, Math.trunc(Number(offset)) || 0);
    const rows = active
      ? db.all(`SELECT * FROM security_bans WHERE ${activeSql} ORDER BY id DESC LIMIT ? OFFSET ?`, [iso(), limit, off])
      : db.all(`SELECT * FROM security_bans ORDER BY id DESC LIMIT ? OFFSET ?`, [limit, off]);
    return rows.map(rowOut);
  }

  function count({ active = true } = {}) {
    return active ? db.get(`SELECT COUNT(*) AS n FROM security_bans WHERE ${activeSql}`, [iso()]).n : db.get('SELECT COUNT(*) AS n FROM security_bans').n;
  }

  /** Cached check used on every request; `ip`/`username` are both optional. */
  function check({ ip, username } = {}) {
    for (const [kind, raw] of [['ip', ip], ['user', username]]) {
      if (!raw) continue;
      let v;
      try { v = normalizeBanValue(kind, raw); } catch { continue; }
      const key = `${kind}|${v}`;
      let c = cache.get(key);
      if (!c || now() - c.at > cacheMs) {
        c = { at: now(), ban: findActive(kind, v) ?? null };
        if (cache.size > 5000) cache = new Map();
        cache.set(key, c);
      }
      if (c.ban) return rowOut(c.ban);
    }
    if (ip) {
      if (!ranges || now() - ranges.at > cacheMs) ranges = { at: now(), rows: db.all(activeRangesSql, [iso()]) };
      const hit = cidrHit(ranges.rows, ip);
      if (hit) return rowOut(hit);
    }
    return null;
  }

  /** Express middleware; mount after attachUser() so banned users are also stopped. */
  function middleware({ onBlocked } = {}) {
    return (req, res, next) => {
      const hit = check({ ip: req.ip, username: req.user?.username });
      if (!hit) return next();
      onBlocked?.(req, hit);
      return sendError(req, res, 403, { error: 'BANNED', fields: [] });
    };
  }

  function purge({ keepDays = 180 } = {}) {
    const cutoff = new Date(now() - keepDays * 86400_000).toISOString();
    return Number(db.run(
      `DELETE FROM security_bans WHERE (lifted_at IS NOT NULL AND lifted_at < ?) OR (expires_at IS NOT NULL AND expires_at < ?)`,
      [cutoff, cutoff]
    ).changes);
  }

  return { ban, lift, list, count, check, middleware, purge, invalidate };
}

export function rowOut(r) {
  return { id: r.id, kind: r.kind, value: r.value, reason: r.reason, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, liftedAt: r.lifted_at, liftedBy: r.lifted_by };
}
