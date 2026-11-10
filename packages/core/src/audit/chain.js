import { createHash } from 'node:crypto';
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

const SENSITIVE_KEY = /pass(word|phrase|wd)?|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|totp|recovery|otp|credential/i;

/**
 * Replaces the value of any key that looks like a credential with
 * "[REDACTED]" (recursively, bounded depth). The audit log is read by
 * admins and exported (privacy module) - a password or session token
 * that slipped into `meta` must not live there forever.
 */
export function redactMeta(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactMeta(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactMeta(v, depth + 1);
  }
  return out;
}

const VERIFY_PAGE = 2000;

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
export function verifyChain(db, { anchor } = {}) {
  ensureAuditTable(db);
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
  return { ok: true, checked };
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
