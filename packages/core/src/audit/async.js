import { asyncDb } from '../database/async.js';
import { columnsAsync } from '../database/helpers-async.js';
import { normalizeLimit } from '../database/identifiers.js';
import { AUDIT_DDL, AUDIT_HASH_COLUMNS, AUDIT_NO_UPDATE_DDL, AUDIT_NO_UPDATE_PG_DDL } from './schema.js';
import { SUBJECTS_DDL, ERASED, isPseudonym, PLAIN_ACTORS, META_PERSON_KEYS, META_IP_KEYS, newPseudonym } from './subjects.js';
import { computeHash, redactMeta, VERIFY_PAGE } from './chain.js';
import { rowToEntry } from './mapper.js';
import { whereFrom, MAX_AUDIT_LIMIT } from './query.js';
import { notifyListeners, HAS_LABEL } from './log.js';
import { purgeStaleSubjectsSql } from './subjects.js';

/**
 * The asynchronous face of the audit trail (ADR-0010, step 3). Same behaviour and the same stored rows as log/query/verifyChain in
 * the synchronous files; the modules that have already moved to `asyncDb` call these, the rest keep the old ones until they move.
 * Both write the same table and the same hash chain, so they can be mixed during the transition.
 * The statements are SQLite's; `a.exec` hands them to the dialect layer, and the append-only trigger has its own PostgreSQL form.
 */
const ensured = new WeakSet();

/** Creates the tables once per database. Call it at start-up: inside a transaction that is later rolled back the tables would be rolled back too. */

export async function ensureAuditTableAsync(db) {
  const a = asyncDb(db);
  if (ensured.has(a)) return;
  for (const sql of AUDIT_DDL) await a.exec(sql);
  const cols = (await columnsAsync(a, 'audit_log')).map((c) => c.name);
  for (const c of AUDIT_HASH_COLUMNS) if (!cols.includes(c)) await a.exec(`ALTER TABLE audit_log ADD COLUMN ${c} TEXT`);
  await a.exec(a.dialect === 'postgres' ? AUDIT_NO_UPDATE_PG_DDL : AUDIT_NO_UPDATE_DDL);
  await a.exec(SUBJECTS_DDL);
  ensured.add(a);
}

export async function pseudonymizeAsync(db, kind, value) {
  if (value === null || value === undefined || value === '') return null;
  const a = asyncDb(db);
  const text = String(value);
  if (kind === 'actor' && PLAIN_ACTORS.has(text)) return text;
  if (isPseudonym(text)) return text;
  const today = new Date().toISOString().slice(0, 10);
  const found = await a.get('SELECT pseudonym, last_seen_day AS day FROM audit_subjects WHERE kind = ? AND value = ?', [kind, text]);
  if (found) {
    if (found.day !== today) await a.run('UPDATE audit_subjects SET last_seen_day = ? WHERE pseudonym = ?', [today, found.pseudonym]);
    return found.pseudonym;
  }
  const pseudonym = newPseudonym(kind);
  const added = await a.run('INSERT INTO audit_subjects (pseudonym, kind, value, created_at, last_seen_day) VALUES (?, ?, ?, ?, ?) ON CONFLICT (kind, value) DO NOTHING', [
    pseudonym, kind, text, new Date().toISOString(), today,
  ]);
  if (Number(added.changes) === 0) return (await a.get('SELECT pseudonym FROM audit_subjects WHERE kind = ? AND value = ?', [kind, text])).pseudonym;
  return pseudonym;
}

export async function findPseudonymAsync(db, kind, value) {
  if (value === null || value === undefined) return null;
  return (await asyncDb(db).get('SELECT pseudonym FROM audit_subjects WHERE kind = ? AND value = ?', [kind, String(value)]))?.pseudonym ?? null;
}

export async function pseudonymizeMetaAsync(db, value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) out.push(await pseudonymizeMetaAsync(db, v, depth + 1));
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && META_PERSON_KEYS.test(k)) out[k] = await pseudonymizeAsync(db, 'actor', v);
    else if (typeof v === 'string' && META_IP_KEYS.test(k)) out[k] = await pseudonymizeAsync(db, 'ip', v);
    else out[k] = await pseudonymizeMetaAsync(db, v, depth + 1);
  }
  return out;
}

/** Loads every pseudonym found in `rows` (actor, ip, meta strings) in one pass, then resolves synchronously. */
async function resolverFor(db, rows) {
  const a = asyncDb(db);
  const found = new Set();
  const scan = (v, depth = 0) => {
    if (typeof v === 'string') { if (isPseudonym(v)) found.add(v); return; }
    if (depth > 6 || v === null || typeof v !== 'object') return;
    for (const x of Array.isArray(v) ? v : Object.values(v)) scan(x, depth + 1);
  };
  for (const r of rows) {
    scan(r.actor); scan(r.ip);
    try { scan(JSON.parse(r.meta)); } catch { /* unreadable meta is reported by rowToEntry */ }
  }
  const map = new Map();
  for (const p of found) map.set(p, (await a.get('SELECT value FROM audit_subjects WHERE pseudonym = ?', [p]))?.value ?? ERASED);
  const lookup = (t) => (isPseudonym(t) ? map.get(t) ?? ERASED : t);
  const meta = (v, depth = 0) => {
    if (depth > 6 || v === null || typeof v !== 'object') return typeof v === 'string' ? lookup(v) : v;
    if (Array.isArray(v)) return v.map((x) => meta(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, meta(x, depth + 1)]));
  };
  return { value: lookup, meta };
}

async function toEntries(db, rows) {
  const resolver = await resolverFor(db, rows);
  return rows.map((r) => rowToEntry(r, resolver));
}

async function withTargetAsync(tx, { entity, entityId, entityLabel }, meta) {
  if (typeof meta !== 'object' || Array.isArray(meta) || Object.keys(meta).some((k) => HAS_LABEL.test(k))) return meta;
  if (entityLabel) return { ...meta, [entity === 'user' ? 'username' : 'target']: String(entityLabel).slice(0, 200) };
  if (entity === 'user' && /^\d+$/.test(String(entityId ?? ''))) {
    try {
      const name = (await tx.get('SELECT username FROM users WHERE id = ?', [Number(entityId)]))?.username;
      if (name) return { ...meta, username: name };
    } catch { /* the users table does not exist here */ }
  }
  return meta;
}

/** `log()` for asynchronous code. Same arguments, same row, same hash chain; resolves to the written entry. */
export async function logAsync(
  db,
  { actor = null, action, entity = null, entityId = null, entityLabel = null, result = 'success', meta = {}, requestId = null, ip = null }
) {
  if (!action) throw new TypeError('audit.log() requires a non-empty `action`');
  if (result !== 'success' && result !== 'failure' && result !== 'denied') {
    throw new TypeError(`audit.log() result must be 'success', 'failure' or 'denied', got: ${result}`);
  }
  const a = asyncDb(db);
  await ensureAuditTableAsync(a);
  const now = new Date().toISOString();
  const inserted = await a.transaction(async (tx) => {
    const last = await tx.get('SELECT hash FROM audit_log WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1');
    const prevHash = last?.hash ?? null;
    const metaJson = JSON.stringify(await pseudonymizeMetaAsync(tx, redactMeta(await withTargetAsync(tx, { entity, entityId, entityLabel }, meta ?? {}))));
    const row = {
      actor: await pseudonymizeAsync(tx, 'actor', actor),
      action,
      entity,
      entity_id: entityId != null ? String(entityId) : null,
      result,
      meta: metaJson,
      request_id: requestId,
      ip: await pseudonymizeAsync(tx, 'ip', ip),
      created_at: now,
    };
    const info = await tx.run(
      `INSERT INTO audit_log (actor, action, entity, entity_id, result, meta, request_id, ip, created_at, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.actor, row.action, row.entity, row.entity_id, row.result, row.meta, row.request_id, row.ip, row.created_at, prevHash, computeHash(prevHash, row)]
    );
    return tx.get('SELECT * FROM audit_log WHERE id = ?', [Number(info.lastInsertRowid)]);
  }, { mode: 'immediate' });
  const [entry] = await toEntries(a, [inserted]);
  notifyListeners(inserted);
  return entry;
}

export async function tailAsync(db, { limit = 50 } = {}) {
  const a = asyncDb(db);
  await ensureAuditTableAsync(a);
  return toEntries(a, await a.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', [normalizeLimit(limit, { fallback: 50, max: MAX_AUDIT_LIMIT })]));
}

async function buildWhereAsync(a, filters) {
  return whereFrom(filters, filters.actor !== undefined ? await findPseudonymAsync(a, 'actor', filters.actor) : null);
}

export async function queryAsync(db, filters = {}) {
  const a = asyncDb(db);
  await ensureAuditTableAsync(a);
  const { limit = 100, offset = 0 } = filters;
  const { where, params } = await buildWhereAsync(a, filters);
  const order = filters.afterId !== undefined && filters.beforeId === undefined ? 'ASC' : 'DESC';
  const rows = await a.all(`SELECT * FROM audit_log${where} ORDER BY id ${order} LIMIT ? OFFSET ?`, [
    ...params,
    normalizeLimit(limit, { fallback: 100, max: MAX_AUDIT_LIMIT }),
    Math.max(0, Math.trunc(Number(offset)) || 0),
  ]);
  return toEntries(a, rows);
}

export async function pageAsync(db, filters = {}) {
  const limit = normalizeLimit(filters.limit ?? 100, { fallback: 100, max: MAX_AUDIT_LIMIT });
  const items = await queryAsync(db, { ...filters, afterId: undefined, offset: 0, limit: limit + 1 });
  const more = items.length > limit;
  if (more) items.pop();
  return { items, nextBeforeId: more ? items[items.length - 1].id : null };
}

export async function countAsync(db, filters = {}) {
  const a = asyncDb(db);
  await ensureAuditTableAsync(a);
  const { where, params } = await buildWhereAsync(a, filters);
  return (await a.get(`SELECT COUNT(*) AS c FROM audit_log${where}`, params)).c;
}

export async function verifyChainAsync(db, { anchor } = {}) {
  const a = asyncDb(db);
  await ensureAuditTableAsync(a);
  let previous = null;
  let checked = 0;
  let afterId = -1;
  for (;;) {
    const rows = await a.all('SELECT * FROM audit_log WHERE hash IS NOT NULL AND id > ? ORDER BY id ASC LIMIT ?', [afterId, VERIFY_PAGE]);
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
    const row = await a.get('SELECT id, hash FROM audit_log WHERE id = ?', [anchor.id]);
    if (!row) return { ok: false, checked, brokenAtId: anchor.id, reason: 'anchored row is missing (log was truncated or rewritten)' };
    if (row.hash !== anchor.hash) return { ok: false, checked, brokenAtId: anchor.id, reason: 'anchored row hash differs (history was rewritten)' };
  }
  return { ok: true, checked };
}

export async function anchorAsync(db) {
  const a = asyncDb(db);
  await ensureAuditTableAsync(a);
  const head = await a.get('SELECT id, hash FROM audit_log WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1');
  if (!head) return null;
  const { c } = await a.get('SELECT COUNT(*) AS c FROM audit_log');
  return { id: head.id, hash: head.hash, count: c, at: new Date().toISOString() };
}

export async function eraseSubjectsAsync(db, { usernames = [], ips = [], exclusiveIps = true } = {}) {
  const a = asyncDb(db);
  await ensureAuditTableAsync(a);
  const actorPseudos = [];
  for (const u of usernames) { const p = await findPseudonymAsync(a, 'actor', u); if (p) actorPseudos.push(p); }
  const ipPseudos = new Set();
  for (const i of ips) { const p = await findPseudonymAsync(a, 'ip', i); if (p) ipPseudos.add(p); }
  if (exclusiveIps) {
    for (const p of actorPseudos) {
      for (const row of await a.all('SELECT DISTINCT ip FROM audit_log WHERE actor = ? AND ip IS NOT NULL', [p])) {
        const other = await a.get('SELECT 1 AS x FROM audit_log WHERE ip = ? AND (actor IS NULL OR actor <> ?) LIMIT 1', [row.ip, p]);
        if (!other) ipPseudos.add(row.ip);
      }
    }
  }
  return a.transaction(async (tx) => {
    let actors = 0;
    let ipCount = 0;
    for (const p of actorPseudos) actors += Number((await tx.run('DELETE FROM audit_subjects WHERE pseudonym = ?', [p])).changes);
    for (const p of ipPseudos) ipCount += Number((await tx.run('DELETE FROM audit_subjects WHERE pseudonym = ?', [p])).changes);
    return { actors, ips: ipCount };
  }, { mode: 'immediate' });
}

export async function purgeStaleSubjectsAsync(db, beforeIso) {
  const a = asyncDb(db);
  await a.exec(SUBJECTS_DDL);
  return Number((await a.run(purgeStaleSubjectsSql, [String(beforeIso).slice(0, 10)])).changes);
}

/** `purgeOlderThan()` for asynchronous code: batches, then stale pseudonyms, optionally records itself. */
export async function purgeOlderThanAsync(db, beforeIso, { record = false, actor = null, batchSize = 5000 } = {}) {
  if (!beforeIso) throw new TypeError('purgeOlderThan() requires a cutoff ISO datetime string');
  const a = asyncDb(db);
  await ensureAuditTableAsync(a);
  const size = Math.max(1, Math.trunc(Number(batchSize)) || 5000);
  let removed = 0;
  for (;;) {
    const n = Number((await a.run('DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE created_at < ? ORDER BY id LIMIT ?)', [beforeIso, size])).changes);
    removed += n;
    if (n < size) break;
  }
  await purgeStaleSubjectsAsync(a, beforeIso);
  if (record) await logAsync(a, { actor, action: 'audit.purge', meta: { before: beforeIso, removed } });
  return removed;
}

/** `purgePersonalData()` for asynchronous code. @returns {Promise<number>} mappings removed */
export async function purgePersonalDataAsync(db, days, { record = true, actor = null, now = Date.now() } = {}) {
  const d = Math.trunc(Number(days));
  if (!Number.isFinite(d) || d < 1) throw new RangeError('purgePersonalData(): days must be an integer >= 1');
  const a = asyncDb(db);
  await ensureAuditTableAsync(a);
  const removed = await purgeStaleSubjectsAsync(a, new Date(now - d * 86_400_000).toISOString());
  if (record && removed > 0) await logAsync(a, { actor, action: 'audit.personal_data.purge', meta: { days: d, removed } });
  return removed;
}
