import { assertSafeIdentifier, normalizeLimit } from './identifiers.js';

/** Most values one IN (...) may carry; SQLite's own limit is higher, a bigger list is a design smell. */
export const MAX_IN_VALUES = 1000;
export const MAX_QUERY_OFFSET = 1_000_000_000;

const COMPARE = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

/** Escapes % _ and \ so a user's text is matched literally inside LIKE (used with ESCAPE '\'). */
export function likeEscape(text) {
  return String(text).replace(/[\\%_]/g, (c) => `\\${c}`);
}

function inList(col, values, negate, params) {
  if (!Array.isArray(values)) throw new TypeError(`${col}: "in" needs an array`);
  if (values.length > MAX_IN_VALUES) throw new RangeError(`${col}: more than ${MAX_IN_VALUES} values in IN`);
  if (values.length === 0) return negate ? '1 = 1' : '1 = 0';
  params.push(...values);
  return `${col} ${negate ? 'NOT IN' : 'IN'} (${values.map(() => '?').join(', ')})`;
}

function columnClauses(col, value, params) {
  if (value === null) return [`${col} IS NULL`];
  if (Array.isArray(value)) return [inList(col, value, false, params)];
  if (!isPlainObject(value)) {
    params.push(value);
    return [`${col} = ?`];
  }
  const out = [];
  for (const [op, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (op === 'eq' || op === 'ne') {
      if (v === null) out.push(`${col} IS ${op === 'ne' ? 'NOT ' : ''}NULL`);
      else (params.push(v), out.push(`${col} ${COMPARE[op]} ?`));
    } else if (COMPARE[op]) {
      params.push(v);
      out.push(`${col} ${COMPARE[op]} ?`);
    } else if (op === 'in' || op === 'notIn') {
      out.push(inList(col, v, op === 'notIn', params));
    } else if (op === 'like' || op === 'notLike') {
      params.push(String(v));
      out.push(`${col} ${op === 'notLike' ? 'NOT LIKE' : 'LIKE'} ? ESCAPE '\\'`);
    } else if (op === 'contains' || op === 'startsWith') {
      params.push(op === 'contains' ? `%${likeEscape(v)}%` : `${likeEscape(v)}%`);
      out.push(`${col} LIKE ? ESCAPE '\\'`);
    } else if (op === 'between') {
      if (!Array.isArray(v) || v.length !== 2) throw new TypeError(`${col}: "between" needs [from, to]`);
      params.push(v[0], v[1]);
      out.push(`${col} BETWEEN ? AND ?`);
    } else {
      throw new TypeError(`${col}: unknown operator "${op}"`);
    }
  }
  if (out.length === 0) throw new TypeError(`${col}: empty operator object`);
  return out;
}

/**
 * Builds " WHERE ..." from an example. `deleted` ('exclude' | 'only' | 'include',
 * default 'include' = no soft-delete filter) works on `deletedColumn`.
 */
export function buildWhere(example = {}, { deleted = 'include', deletedColumn = 'deleted_at' } = {}) {
  const clauses = [];
  const params = [];
  for (const [col, value] of Object.entries(example)) {
    if (value === undefined) continue;
    assertSafeIdentifier(col, 'column');
    clauses.push(...columnClauses(col, value, params));
  }
  if (deleted !== 'include') {
    if (deleted !== 'exclude' && deleted !== 'only') throw new TypeError(`deleted: unknown mode "${deleted}"`);
    assertSafeIdentifier(deletedColumn, 'column');
    clauses.push(`${deletedColumn} IS ${deleted === 'only' ? 'NOT ' : ''}NULL`);
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

function orderSql(orderBy) {
  const items = Array.isArray(orderBy) ? orderBy : [orderBy];
  return items
    .map((item) => {
      assertSafeIdentifier(String(item).replace(/\s+(ASC|DESC)$/i, ''), 'orderBy');
      return item;
    })
    .join(', ');
}

/**
 * db.queryByExample(table, example, opts) — builds a parameterized SELECT
 * from a plain object, so call sites don't hand-roll string-concatenated
 * WHERE clauses. `undefined` values are skipped; `null` becomes `IS NULL`.
 *
 * Per-column value:
 *   'x' | 5            equality
 *   null               IS NULL
 *   ['a','b']          IN (...)        ([] matches nothing)
 *   { gt, gte, lt, lte, ne, eq }       comparisons
 *   { in, notIn }                      lists
 *   { like, notLike }                  raw pattern, ESCAPE '\'
 *   { contains, startsWith }           text matched literally (escaped for you)
 *   { between: [from, to] }
 * Several keys in one object are ANDed. There is no OR - use raw SQL for that.
 *
 * opts: limit, offset, orderBy (string or array), deleted ('exclude'|'only'|'include'),
 * deletedColumn.
 */
export function queryByExample({ all }, table, example = {}, { limit, offset, orderBy, deleted, deletedColumn } = {}) {
  assertSafeIdentifier(table, 'table');
  const where = buildWhere(example, { deleted, deletedColumn });
  let sql = `SELECT * FROM ${table}${where.sql}`;
  if (orderBy) sql += ` ORDER BY ${orderSql(orderBy)}`;
  const hasLimit = limit !== undefined && limit !== null;
  const off = offset === undefined || offset === null ? 0 : Math.min(Math.max(0, Math.trunc(Number(offset)) || 0), MAX_QUERY_OFFSET);
  if (hasLimit) sql += ` LIMIT ${normalizeLimit(limit, { fallback: 20 })}`;
  else if (off > 0) sql += ' LIMIT -1';
  if (off > 0) sql += ` OFFSET ${off}`;
  return all(sql, where.params);
}

/** SELECT COUNT(*) over the same example (for paging: total next to a page). */
export function countByExample({ get }, table, example = {}, { deleted, deletedColumn } = {}) {
  assertSafeIdentifier(table, 'table');
  const where = buildWhere(example, { deleted, deletedColumn });
  return get(`SELECT COUNT(*) AS n FROM ${table}${where.sql}`, where.params).n;
}

const encodeCursor = (v) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
function decodeCursor(c) {
  try {
    const v = JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8'));
    if (typeof v === 'string' || typeof v === 'number') return v;
  } catch { /* falls through */ }
  throw new TypeError('pageByExample: invalid cursor');
}

/**
 * Keyset ("after this row") paging over an example, stable while rows are added or removed - unlike OFFSET,
 * which skips or repeats rows and slows down on deep pages. Order is ONE unique, indexed column (default `id`).
 *
 * `pageByExample(db, 'assets', { status: 'active' }, { pageSize: 25, cursor })` returns
 * `{ rows, nextCursor, total? }`; pass `nextCursor` back as `cursor` for the next page (`null` = last page).
 * The cursor is opaque text, safe to put in a URL; a tampered one is rejected, never injected into SQL.
 *
 * opts: pageSize (1..1000, default 20), cursor, orderBy (column), direction ('asc'|'desc'), withTotal,
 * deleted, deletedColumn.
 */
export function pageByExample({ all, get }, table, example = {}, { pageSize = 20, cursor, orderBy = 'id', direction = 'asc', withTotal = false, deleted, deletedColumn } = {}) {
  assertSafeIdentifier(table, 'table');
  assertSafeIdentifier(orderBy, 'orderBy');
  const dir = String(direction).toLowerCase() === 'desc' ? 'desc' : 'asc';
  const size = normalizeLimit(pageSize, { fallback: 20 });
  const where = buildWhere(example, { deleted, deletedColumn });
  const params = [...where.params];
  let sql = where.sql;
  if (cursor !== undefined && cursor !== null && cursor !== '') {
    sql += `${sql ? ' AND' : ' WHERE'} ${orderBy} ${dir === 'asc' ? '>' : '<'} ?`;
    params.push(decodeCursor(cursor));
  }
  const rows = all(`SELECT * FROM ${table}${sql} ORDER BY ${orderBy} ${dir.toUpperCase()} LIMIT ${size + 1}`, params);
  const hasMore = rows.length > size;
  if (hasMore) rows.length = size;
  const out = { rows, nextCursor: hasMore ? encodeCursor(rows[rows.length - 1][orderBy]) : null };
  if (withTotal) out.total = get(`SELECT COUNT(*) AS n FROM ${table}${where.sql}`, where.params).n;
  return out;
}
