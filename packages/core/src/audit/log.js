import { ensureAuditTable } from './schema.js';
import { rowToEntry } from './mapper.js';
import { createResolver, pseudonymize, pseudonymizeMeta } from './subjects.js';
import { computeHash, redactMeta } from './chain.js';

/**
 * Records one audit entry. This is the module's entire write surface -
 * audit_log is append-only, there is no update()/delete() for a single
 * row, only purgeOlderThan() (retention.js) for bulk cleanup.
 *
 * `action` is the only required field; everything else defaults to
 * "unknown/none" rather than throwing, because a logging call that
 * itself fails (e.g. on a missing optional field) must never be what
 * takes down the request it was trying to record.
 *
 * @param db - a DatabaseAdapter (core/database)
 * @param {object} entry
 * @param {string|null} [entry.actor] - username/id, or null for
 *   unauthenticated/system-initiated events
 * @param {string} entry.action - dot-namespaced verb, e.g. 'auth.login'
 * @param {string|null} [entry.entity] - entity type, e.g. 'user'
 * @param {string|number|null} [entry.entityId]
 * @param {'success'|'failure'|'denied'} [entry.result='success'] - `denied`: refused by access rules (not a fault)
 * @param {string|null} [entry.entityLabel] - what the object was called AT THIS MOMENT (a title, a name), kept in `meta.target`
 *   so the record still reads after a rename or deletion. For a `user` object the login is found by itself and kept as `meta.username`
 *   (a pseudonym, erasable like the actor). Put no personal data into `entityLabel` of other objects.
 * @param {object} [entry.meta] - arbitrary JSON-serializable detail
 * @param {string|null} [entry.requestId] - correlates with req.id
 *   (core/http's requestId() middleware)
 * @param {string|null} [entry.ip]
 * @returns the inserted entry, including its generated id/createdAt
 */
const listeners = new Set();

/**
 * Subscribes to every entry as it is written: `fn({entry, hash, prevHash})`. This is how a copy of
 * the audit trail can leave the machine (see core/logs `mirrorAuditToLogs`): rows an intruder
 * deletes from the local database still exist at the remote log. A throwing listener is ignored;
 * it is called after the row is inserted (inside the caller's transaction, if there is one).
 * @returns {() => void} unsubscribe
 */
export function onEntry(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const HAS_LABEL = /^(username|login|user|target)$/i;

/** Adds what the object is called right now to `meta`, unless the caller already said it. Never throws (no users table = no label). */
function withTarget(tx, { entity, entityId, entityLabel }, meta) {
  if (typeof meta !== 'object' || Array.isArray(meta) || Object.keys(meta).some((k) => HAS_LABEL.test(k))) return meta;
  if (entityLabel) return { ...meta, [entity === 'user' ? 'username' : 'target']: String(entityLabel).slice(0, 200) };
  if (entity === 'user' && /^\d+$/.test(String(entityId ?? ''))) {
    try {
      const name = tx.get('SELECT username FROM users WHERE id = ?', [Number(entityId)])?.username;
      if (name) return { ...meta, username: name };
    } catch { /* the users table does not exist here */ }
  }
  return meta;
}

export function log(
  db,
  { actor = null, action, entity = null, entityId = null, entityLabel = null, result = 'success', meta = {}, requestId = null, ip = null }
) {
  if (!action) {
    throw new TypeError('audit.log() requires a non-empty `action`');
  }
  if (result !== 'success' && result !== 'failure' && result !== 'denied') {
    throw new TypeError(`audit.log() result must be 'success', 'failure' or 'denied', got: ${result}`);
  }

  ensureAuditTable(db);
  const now = new Date().toISOString();
  // The read of the previous hash and the insert must be one atomic step,
  // otherwise two writers (server + CLI) fork the chain. If the caller is
  // already inside a transaction this nests as a savepoint.
  const insert = (tx) => {
    const last = tx.get('SELECT hash FROM audit_log WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1');
    const prevHash = last?.hash ?? null;
    // personal data goes to audit_subjects, the row keeps pseudonyms (erasable, chain stays valid)
    const metaJson = JSON.stringify(pseudonymizeMeta(tx, redactMeta(withTarget(tx, { entity, entityId, entityLabel }, meta ?? {}))));
    const row = {
      actor: pseudonymize(tx, 'actor', actor),
      action,
      entity,
      entity_id: entityId != null ? String(entityId) : null,
      result,
      meta: metaJson,
      request_id: requestId,
      ip: pseudonymize(tx, 'ip', ip),
      created_at: now,
    };
    tx.run(
      `INSERT INTO audit_log (actor, action, entity, entity_id, result, meta, request_id, ip, created_at, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.actor, row.action, row.entity, row.entity_id, row.result, row.meta, row.request_id, row.ip, row.created_at, prevHash, computeHash(prevHash, row)]
    );
    return tx.get(`SELECT * FROM audit_log WHERE rowid = last_insert_rowid()`);
  };

  const inserted = typeof db.transaction === 'function' ? db.transaction(insert, { mode: 'immediate' }) : insert(db);
  const entry = rowToEntry(inserted, createResolver(db));
  const rawEntry = rowToEntry(inserted);
  for (const fn of listeners) {
    try {
      fn({ entry: rawEntry, hash: inserted.hash, prevHash: inserted.prev_hash });
    } catch {
      /* a listener must never break the audit write */
    }
  }
  return entry;
}
