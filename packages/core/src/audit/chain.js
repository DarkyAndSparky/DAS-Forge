import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ensureAuditTable } from './schema.js';

/** Hash of one row's content plus the previous row's hash. */
export function computeHash(prevHash, row) {
  const payload = JSON.stringify([
    prevHash ?? '',
    row.actor ?? null,
    row.action,
    row.entity ?? null,
    row.entity_id ?? null,
    row.result,
    row.meta,
    row.request_id ?? null,
    row.ip ?? null,
    row.created_at,
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Seal (audit R-01). The chain hash alone proves nothing against someone who can write the database: they can recompute
 * every hash. A seal is HMAC-SHA256(key, hash) with a key that is NOT in the database (`audit.sealKey`), written
 * with every new row. Without the key nobody can forge a row that verifies. The first key signs, every listed key verifies (rotation).
 * Rows from before sealing started stay valid without a seal; once a sealed row is seen, a later row without a seal is a break.
 */
let sealKeys = [];
const sealInfo = 'das-forge/audit-seal/v1:';

/** Set (once, at start-up) the key(s) that seal new rows; `null` or an empty list turns sealing off. */
export function setSealKeys(keys) {
  const list = (Array.isArray(keys) ? keys : keys ? [keys] : []).filter((k) => typeof k === 'string' && k.length >= 32);
  sealKeys = list;
}
export const sealingActive = () => sealKeys.length > 0;

export function sealOf(hash, key = sealKeys[0]) {
  return key ? createHmac('sha256', key).update(sealInfo + hash).digest('hex') : null;
}

/** State of one verification run, and the verdict on one row. Returns a failure reason or null. */
export function newSealState(keys = sealKeys) {
  return { keys, sealed: 0, unverified: 0, started: false };
}
export function checkSeal(state, row) {
  if (row.seal) {
    state.started = true;
    if (state.keys.length === 0) { state.unverified++; return null; } // sealed, but this run has no key to check it with
    const given = Buffer.from(String(row.seal), 'utf8');
    const ok = state.keys.some((k) => { const want = Buffer.from(sealOf(row.hash, k), 'utf8'); return want.length === given.length && timingSafeEqual(want, given); });
    if (!ok) return 'the seal does not match (the row was written without the key, or the key is not the one that sealed it)';
    state.sealed++;
    return null;
  }
  if (state.started) return 'a row without a seal after sealing had started (written without the key)';
  return null;
}

const SENSITIVE_KEY = /pass(word|phrase|wd)?|pwd|secret|token|authorization|bearer|jwt|cookie|api[-_]?key|private[-_]?key|totp|recovery|otp|credential|session[-_]?id|credit[-_]?card|card[-_]?(number|no)|cvv|cvc|(^|[-_.])(sid|pin|iban)($|[-_.])/i;

/** Credentials that sit inside a text value (audit S-05): `Bearer x`, a JWT, `?token=x`, `password: x`. */
const VALUE_PATTERNS = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED]'],
  [/\b((?:access[_-]?|refresh[_-]?|id[_-]?|api[_-]?|auth[_-]?|session[_-]?)?(?:token|key|secret|password|passwd|pwd|sid|sessionid|code)|authorization)(\s*[=:]\s*)("?)[^\s&;,"'<>]{3,}/gi, '$1$2$3[REDACTED]'],
];
const MAX_SCANNED = 8000;

/** Text with the credentials inside it blanked out. */
export function redactText(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  let t = s.length > MAX_SCANNED ? s.slice(0, MAX_SCANNED) : s;
  for (const [re, to] of VALUE_PATTERNS) t = t.replace(re, to);
  return s.length > MAX_SCANNED ? `${t}...[truncated]` : t;
}

/**
 * Replaces the value of any key that looks like a credential with
 * "[REDACTED]" (recursively, bounded depth). The audit log is read by
 * admins and exported (privacy module) - a password or session token
 * that slipped into `meta` must not live there forever.
 */
export function redactMeta(value, depth = 0) {
  if (typeof value === 'string') return redactText(value);
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactMeta(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactMeta(v, depth + 1);
  }
  return out;
}

export const VERIFY_PAGE = 2000;

/**
 * Walks the chain from the oldest hashed row. Rows without a hash
 * (written before 0.1.28, or raw-inserted) are skipped; the first hashed
 * row is the anchor (its prev_hash may point at rows retention already
 * deleted). After that every row must (1) link to the previous row's hash
 * and (2) hash to its own stored value.
 *
 * With `anchor` (a value from `anchor(db)` stored OUTSIDE the database), also
 * proves that row still exists with the same hash - this is what detects a
 * wholesale rewrite or tail truncation that keeps the chain self-consistent.
 * @returns {{ok: true, checked: number} | {ok: false, checked: number, brokenAtId: number, reason: string}}
 */
export function verifyChain(db, { anchor, readOnly = false, sealKey } = {}) {
  if (!readOnly) ensureAuditTable(db); // a read-only copy (a backup being inspected) is never altered
  const seal = newSealState(sealKey === undefined ? sealKeys : (Array.isArray(sealKey) ? sealKey : sealKey ? [sealKey] : []));
  let previous = null;
  let checked = 0;
  // Keyset pages (audit I04): a log of millions of rows must not be loaded into memory at once.
  let afterId = -1;
  for (;;) {
    const rows = db.all('SELECT * FROM audit_log WHERE hash IS NOT NULL AND id > ? ORDER BY id ASC LIMIT ?', [afterId, VERIFY_PAGE]);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (previous && row.prev_hash !== previous.hash) {
        return { ok: false, checked, brokenAtId: row.id, reason: 'prev_hash does not match the previous row (a row was removed or reordered)' };
      }
      if (computeHash(row.prev_hash, row) !== row.hash) {
        return { ok: false, checked, brokenAtId: row.id, reason: 'row content does not match its hash (row was modified)' };
      }
      const sealBreak = checkSeal(seal, row);
      if (sealBreak) return { ok: false, checked, brokenAtId: row.id, reason: sealBreak };
      previous = { id: row.id, hash: row.hash };
      checked++;
    }
    afterId = rows[rows.length - 1].id;
    if (rows.length < VERIFY_PAGE) break;
  }
  if (anchor) {
    const row = db.get('SELECT id, hash FROM audit_log WHERE id = ?', [anchor.id]);
    if (!row) return { ok: false, checked, brokenAtId: anchor.id, reason: 'anchored row is missing (log was truncated or rewritten)' };
    if (row.hash !== anchor.hash) return { ok: false, checked, brokenAtId: anchor.id, reason: 'anchored row hash differs (history was rewritten)' };
  }
  return seal.sealed || seal.unverified ? { ok: true, checked, sealed: seal.sealed, unverifiedSeals: seal.unverified } : { ok: true, checked };
}

/**
 * Snapshot of the chain head, to be kept somewhere an attacker with DB
 * write access cannot reach (a log line shipped off-host, a ticket, paper).
 * Later: verifyChain(db, { anchor }).
 * @returns {{id:number, hash:string, count:number, at:string} | null}
 */
export function anchor(db) {
  ensureAuditTable(db);
  const head = db.get('SELECT id, hash FROM audit_log WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1');
  if (!head) return null;
  const { c } = db.get('SELECT COUNT(*) AS c FROM audit_log');
  return { id: head.id, hash: head.hash, count: c, at: new Date().toISOString() };
}
