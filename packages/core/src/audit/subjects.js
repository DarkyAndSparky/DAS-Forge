import { randomBytes } from 'node:crypto';

/**
 * Erasable pseudonyms for the audit trail (audit F03).
 *
 * audit_log is append-only and hash-chained, so a login or IP written into it could never be
 * removed for a GDPR/152-FZ erasure request. Instead the row stores a random pseudonym
 * ("~a:1f3c..." for a person, "~i:..." for an IP address) and the real value lives in
 * audit_subjects. The hash covers the pseudonym, so deleting the mapping (eraseSubjects)
 * leaves the chain valid while the row can no longer be tied to anyone: it reads "[erased]".
 *
 * Names that are not personal data ('system', 'cli') are stored as they are.
 * Rows written before this feature hold the plain value and cannot be erased (editing them
 * would break the chain) - they age out through audit.retentionDays.
 */
const PSEUDONYM = /^~([ai]):[0-9a-f]{16}$/;
const PLAIN_ACTORS = new Set(['system', 'cli']);
export const ERASED = '[erased]';

/** keys in `meta` whose values are personal data and get pseudonymized like actor/ip */
const META_PERSON_KEYS = /^(username|login|user|email|actor)$/i;
const META_IP_KEYS = /^(ip|ipAddress|remoteAddress)$/i;

export function ensureSubjectsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_subjects (
      pseudonym TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('actor', 'ip')),
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_day TEXT NOT NULL,
      UNIQUE (kind, value)
    );
  `);
}

export function isPseudonym(value) {
  return typeof value === 'string' && PSEUDONYM.test(value);
}

/** Returns the pseudonym for a value, creating the mapping on first use. null stays null. */
export function pseudonymize(db, kind, value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  if (kind === 'actor' && PLAIN_ACTORS.has(text)) return text;
  if (isPseudonym(text)) return text;
  const today = new Date().toISOString().slice(0, 10);
  const found = db.get('SELECT pseudonym, last_seen_day AS day FROM audit_subjects WHERE kind = ? AND value = ?', [kind, text]);
  if (found) {
    if (found.day !== today) db.run('UPDATE audit_subjects SET last_seen_day = ? WHERE pseudonym = ?', [today, found.pseudonym]);
    return found.pseudonym;
  }
  const pseudonym = `~${kind === 'actor' ? 'a' : 'i'}:${randomBytes(8).toString('hex')}`;
  // UNIQUE (kind, value): if another process added this value between our SELECT and now, the INSERT does nothing and we
  // use ITS pseudonym, instead of failing the audit write with a constraint error (G-04).
  const added = db.run('INSERT INTO audit_subjects (pseudonym, kind, value, created_at, last_seen_day) VALUES (?, ?, ?, ?, ?) ON CONFLICT (kind, value) DO NOTHING', [
    pseudonym, kind, text, new Date().toISOString(), today,
  ]);
  if (Number(added.changes) === 0) return db.get('SELECT pseudonym FROM audit_subjects WHERE kind = ? AND value = ?', [kind, text]).pseudonym;
  return pseudonym;
}

/** Looks a pseudonym up without creating anything (for filters). */
export function findPseudonym(db, kind, value) {
  if (value === null || value === undefined) return null;
  return db.get('SELECT pseudonym FROM audit_subjects WHERE kind = ? AND value = ?', [kind, String(value)])?.pseudonym ?? null;
}

/** Pseudonymizes person/IP values inside `meta` (recursively, bounded depth). */
export function pseudonymizeMeta(db, value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => pseudonymizeMeta(db, v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && META_PERSON_KEYS.test(k)) out[k] = pseudonymize(db, 'actor', v);
    else if (typeof v === 'string' && META_IP_KEYS.test(k)) out[k] = pseudonymize(db, 'ip', v);
    else out[k] = pseudonymizeMeta(db, v, depth + 1);
  }
  return out;
}

/** Resolves a stored value to the real one; an erased pseudonym becomes "[erased]". */
export function createResolver(db) {
  const cache = new Map();
  const lookup = (text) => {
    if (!isPseudonym(text)) return text;
    if (!cache.has(text)) cache.set(text, db.get('SELECT value FROM audit_subjects WHERE pseudonym = ?', [text])?.value ?? ERASED);
    return cache.get(text);
  };
  const meta = (value, depth = 0) => {
    if (depth > 6 || value === null || typeof value !== 'object') return typeof value === 'string' ? lookup(value) : value;
    if (Array.isArray(value)) return value.map((v) => meta(v, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, meta(v, depth + 1)]));
  };
  return { value: lookup, meta };
}

/**
 * Erases personal data from the audit trail: deletes the mapping rows, so every row that
 * carries these pseudonyms now reads "[erased]". The hash chain stays valid.
 * @param {object} opts
 * @param {string[]} [opts.usernames] - logins to erase (all pseudonymized spellings)
 * @param {string[]} [opts.ips] - IP addresses to erase
 * @param {boolean} [opts.exclusiveIps=true] - also erase IPs that appear ONLY in rows of the
 *   erased usernames (an address shared with other people stays, so their trail is not damaged)
 * @returns {{actors: number, ips: number}} mapping rows removed
 */
export function eraseSubjects(db, { usernames = [], ips = [], exclusiveIps = true } = {}) {
  ensureSubjectsTable(db);
  if (!db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'")) return { actors: 0, ips: 0 };
  const actorPseudos = usernames.map((u) => findPseudonym(db, 'actor', u)).filter(Boolean);
  const ipPseudos = new Set(ips.map((i) => findPseudonym(db, 'ip', i)).filter(Boolean));
  if (exclusiveIps) {
    for (const p of actorPseudos) {
      for (const row of db.all('SELECT DISTINCT ip FROM audit_log WHERE actor = ? AND ip IS NOT NULL', [p])) {
        const other = db.get('SELECT 1 AS x FROM audit_log WHERE ip = ? AND (actor IS NULL OR actor <> ?) LIMIT 1', [row.ip, p]);
        if (!other) ipPseudos.add(row.ip);
      }
    }
  }
  let actors = 0;
  let ipCount = 0;
  const run = (tx) => {
    for (const p of actorPseudos) actors += Number(tx.run('DELETE FROM audit_subjects WHERE pseudonym = ?', [p]).changes);
    for (const p of ipPseudos) ipCount += Number(tx.run('DELETE FROM audit_subjects WHERE pseudonym = ?', [p]).changes);
  };
  if (typeof db.transaction === 'function') db.transaction(run, { mode: 'immediate' });
  else run(db);
  return { actors, ips: ipCount };
}

/** Drops mappings not used since `beforeIso`'s day (called by retention together with the row purge). */
export function purgeStaleSubjects(db, beforeIso) {
  ensureSubjectsTable(db);
  return Number(db.run('DELETE FROM audit_subjects WHERE last_seen_day < ?', [String(beforeIso).slice(0, 10)]).changes);
}
