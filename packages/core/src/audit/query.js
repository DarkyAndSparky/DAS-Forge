import { ensureAuditTable } from './schema.js';
import { rowsToEntries } from './mapper.js';
import { findPseudonym } from './subjects.js';
import { normalizeLimit } from '../database/identifiers.js';

const MAX_AUDIT_LIMIT = 1000;

/**
 * Most recent N entries, newest first. This is what a "live tail" view
 * (Workshop Stage D, future `app audit tail` CLI command) calls on
 * every poll/SSE tick - kept as its own function rather than
 * query({}, {limit}) because it's the overwhelmingly common case and
 * deserves a name that says so.
 */
export function tail(db, { limit = 50 } = {}) {
  ensureAuditTable(db);
  const rows = db.all(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`, [normalizeLimit(limit, { fallback: 50, max: MAX_AUDIT_LIMIT })]);
  return rowsToEntries(db, rows);
}

/** Accepts Date, ISO string, 'YYYY-MM-DD' or SQLite 'YYYY-MM-DD HH:MM:SS'; returns canonical ISO (audit B14). */
export function normalizeTimestamp(value, name = 'timestamp') {
  const d = value instanceof Date ? value : new Date(/^\d{4}-\d{2}-\d{2} \d/.test(String(value)) ? `${String(value).replace(' ', 'T')}Z` : value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`audit: invalid ${name}: ${String(value)}`);
  return d.toISOString();
}

/** Rows written before 0.1.28 may hold 'YYYY-MM-DD HH:MM:SS'; compare them as ISO so ranges are not off by the 'T'/' ' sort order. */
const CREATED_AT_ISO = `(CASE WHEN created_at LIKE '____-__-__ %' THEN replace(created_at, ' ', 'T') || '.000Z' ELSE created_at END)`;

function buildWhere(db, { actor, action, actionContains, actionPrefix, entity, entityId, requestId, result, since, until, beforeId, afterId } = {}) {
  const clauses = [];
  const params = [];
  if (actor !== undefined) {
    // rows hold pseudonyms; rows from before 0.1.82 hold the plain name
    const p = findPseudonym(db, 'actor', actor);
    if (p) { clauses.push('actor IN (?, ?)'); params.push(p, actor); } else { clauses.push('actor = ?'); params.push(actor); }
  }
  if (action !== undefined) { clauses.push('action = ?'); params.push(action); }
  if (actionContains !== undefined) { clauses.push(`action LIKE ? ESCAPE '\\'`); params.push(`%${String(actionContains).replace(/[\\%_]/g, '\\$&')}%`); }
  if (actionPrefix !== undefined) { clauses.push(`action LIKE ? ESCAPE '\\'`); params.push(`${String(actionPrefix).replace(/[\\%_]/g, '\\$&')}%`); }
  if (entity !== undefined) { clauses.push('entity = ?'); params.push(entity); }
  if (entityId !== undefined) { clauses.push('entity_id = ?'); params.push(String(entityId)); }
  if (requestId !== undefined) { clauses.push('request_id = ?'); params.push(String(requestId)); }
  if (result !== undefined) { clauses.push('result = ?'); params.push(result); }
  if (since !== undefined) { clauses.push(`${CREATED_AT_ISO} >= ?`); params.push(normalizeTimestamp(since, 'since')); }
  if (until !== undefined) { clauses.push(`${CREATED_AT_ISO} <= ?`); params.push(normalizeTimestamp(until, 'until')); }
  if (beforeId !== undefined) { clauses.push('id < ?'); params.push(Number(beforeId)); }
  if (afterId !== undefined) { clauses.push('id > ?'); params.push(Number(afterId)); }
  return { where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * Filtered audit search. Deliberately a hand-written WHERE builder
 * rather than database/query-by-example.js's queryByExample(): QBE only
 * does flat equality, but audit search routinely needs a date range
 * (since/until) alongside equality filters, which QBE's contract
 * doesn't cover.
 *
 * Every filter is optional and ANDed together; omitted filters are not
 * included in the WHERE clause at all (not even as `col = NULL`).
 *
 * @param db - a DatabaseAdapter
 * @param {object} [filters]
 * @param {string} [filters.actor]
 * @param {string} [filters.action]
 * @param {string} [filters.actionContains] - a part of the action code (case-insensitive in SQLite for ASCII)
 * @param {string} [filters.entity]
 * @param {string|number} [filters.entityId]
 * @param {string} [filters.requestId] - every event of one request
 * @param {'success'|'failure'|'denied'} [filters.result]
 * @param {string} [filters.since] - ISO datetime, inclusive lower bound
 * @param {string} [filters.until] - ISO datetime, inclusive upper bound
 * @param {number} [filters.limit=100]
 * @param {number} [filters.offset=0]
 */
export function query(db, filters = {}) {
  ensureAuditTable(db);
  const { limit = 100, offset = 0 } = filters;
  const { where, params } = buildWhere(db, filters);
  const order = filters.afterId !== undefined && filters.beforeId === undefined ? 'ASC' : 'DESC';
  const rows = db.all(`SELECT * FROM audit_log${where} ORDER BY id ${order} LIMIT ? OFFSET ?`, [
    ...params,
    normalizeLimit(limit, { fallback: 100, max: MAX_AUDIT_LIMIT }),
    Math.max(0, Math.trunc(Number(offset)) || 0),
  ]);
  return rowsToEntries(db, rows);
}

/**
 * Keyset page, newest first: pass the previous page's `nextBeforeId` as
 * `beforeId` for the next page. Stable while new entries are appended
 * (OFFSET paging is not) and O(log n) per page.
 * @returns {{items: object[], nextBeforeId: number|null}}
 */
export function page(db, filters = {}) {
  const limit = normalizeLimit(filters.limit ?? 100, { fallback: 100, max: MAX_AUDIT_LIMIT });
  const items = query(db, { ...filters, afterId: undefined, offset: 0, limit: limit + 1 });
  const more = items.length > limit;
  if (more) items.pop();
  return { items, nextBeforeId: more ? items[items.length - 1].id : null };
}

/**
 * Total count matching the same filter set as query() (minus
 * limit/offset) - for pagination UIs that need a page count.
 */
export function count(db, filters = {}) {
  ensureAuditTable(db);
  const { where, params } = buildWhere(db, filters);
  return db.get(`SELECT COUNT(*) AS c FROM audit_log${where}`, params).c;
}
