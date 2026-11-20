import { asyncDb } from './async.js';
import { assertSafeIdentifier } from './identifiers.js';
import { buildWhere } from './query-by-example.js';

/**
 * Asynchronous twins of the helpers in `helpers.js` (ADR-0010). They take any database (`asyncDb(db)` is applied), return
 * Promises, and look at `dialect` where SQLite and PostgreSQL differ. Statements keep `?` placeholders: a driver translates
 * them. What only SQLite can do (triggers made by hand, the 12-step rebuild, FTS5) throws a clear error on another dialect
 * until the dialect layer of ADR-0010 provides the equivalent.
 */
const NOW = {
  sqlite: "strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  postgres: "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
};
const nowSql = (a) => NOW[a.dialect] ?? NOW.sqlite;
function onlySqlite(a, what) {
  if (a.dialect !== 'sqlite') throw new Error(`${what} is not available for the "${a.dialect}" dialect yet (ADR-0010, dialect layer)`);
}

/** @returns {Promise<{changes:number, lastInsertRowid:number|bigint}>} */
export async function upsertAsync(db, table, row, conflictColumns, { updateColumns } = {}) {
  assertSafeIdentifier(table);
  const cols = Object.keys(row);
  if (cols.length === 0) throw new TypeError('upsert: row must have at least one column');
  cols.forEach((c) => assertSafeIdentifier(c));
  conflictColumns.forEach((c) => assertSafeIdentifier(c));
  const update = (updateColumns ?? cols.filter((c) => !conflictColumns.includes(c))).map((c) => assertSafeIdentifier(c) ?? c);
  const set = update.length ? update.map((c) => `${c} = excluded.${c}`).join(', ') : null;
  const sql =
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ` +
    `ON CONFLICT(${conflictColumns.join(', ')}) ` +
    (set ? `DO UPDATE SET ${set}` : 'DO NOTHING');
  return asyncDb(db).run(sql, cols.map((c) => row[c]));
}

/** Does the table exist? SQLite keeps the list in `sqlite_master`, PostgreSQL in `information_schema`. */
export async function tableExistsAsync(db, name) {
  const a = asyncDb(db);
  const sql = a.dialect === 'postgres'
    ? 'SELECT 1 AS x FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?'
    : "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?";
  return Boolean(await a.get(sql, [name]));
}

/**
 * The columns of a table, in order, for either dialect: `{ name, notnull }` (`notnull` is 1 or 0 like `PRAGMA table_info`).
 * An unknown table gives an empty list.
 */
export async function columnsAsync(db, table) {
  assertSafeIdentifier(table);
  const a = asyncDb(db);
  if (a.dialect === 'postgres') {
    return (await a.all(
      `SELECT column_name AS name, CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END AS notnull FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position`,
      [table]
    )).map((c) => ({ name: c.name, notnull: Number(c.notnull) }));
  }
  return (await a.all(`PRAGMA table_info(${table})`)).map((c) => ({ name: c.name, notnull: c.notnull ? 1 : 0 }));
}

/** @returns {Promise<boolean>} true when the table has the column (either dialect) */
export async function hasColumnAsync(db, table, column) {
  return (await columnsAsync(db, table)).some((c) => c.name === column);
}

/** @returns {Promise<boolean>} true if the column was added */
export async function addColumnIfMissingAsync(db, table, column, definition) {
  assertSafeIdentifier(table);
  assertSafeIdentifier(column);
  const a = asyncDb(db);
  const exists = await hasColumnAsync(a, table, column);
  if (exists) return false;
  await a.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/** SQLite only for now. @returns {Promise<boolean>} true if the trigger was created now */
export async function addUpdatedAtTriggerAsync(db, table, { column = 'updated_at' } = {}) {
  assertSafeIdentifier(table);
  assertSafeIdentifier(column);
  const a = asyncDb(db);
  onlySqlite(a, 'addUpdatedAtTrigger');
  await addColumnIfMissingAsync(a, table, column, 'TEXT');
  const name = `trg_${table}_${column}`;
  if (await a.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'trigger' AND name = ?`, [name])) return false;
  await a.exec(
    `CREATE TRIGGER ${name} AFTER UPDATE ON ${table} FOR EACH ROW ` +
      `WHEN NEW.${column} IS OLD.${column} ` +
      `BEGIN UPDATE ${table} SET ${column} = ${NOW.sqlite} WHERE rowid = NEW.rowid; END`
  );
  return true;
}

/** @returns {Promise<boolean>} true if the column was added */
export async function addSoftDeleteAsync(db, table, { column = 'deleted_at' } = {}) {
  assertSafeIdentifier(table);
  assertSafeIdentifier(column);
  const a = asyncDb(db);
  const added = await addColumnIfMissingAsync(a, table, column, 'TEXT');
  await a.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_${column} ON ${table}(${column})`);
  return added;
}

/** @returns {Promise<number>} rows affected */
export async function softDeleteAsync(db, table, example, { column = 'deleted_at' } = {}) {
  assertSafeIdentifier(table);
  assertSafeIdentifier(column);
  const where = buildWhere(example);
  if (!where.sql) throw new TypeError('softDelete: an empty example would delete every row');
  const a = asyncDb(db);
  return Number((await a.run(`UPDATE ${table} SET ${column} = ${nowSql(a)}${where.sql} AND ${column} IS NULL`, where.params)).changes);
}

/** @returns {Promise<number>} rows affected */
export async function restoreDeletedAsync(db, table, example, { column = 'deleted_at' } = {}) {
  assertSafeIdentifier(table);
  assertSafeIdentifier(column);
  const where = buildWhere(example);
  if (!where.sql) throw new TypeError('restoreDeleted: an empty example would restore every row');
  return Number((await asyncDb(db).run(`UPDATE ${table} SET ${column} = NULL${where.sql} AND ${column} IS NOT NULL`, where.params)).changes);
}

/** @returns {Promise<number>} */
export async function purgeDeletedAsync(db, table, { olderThanDays, column = 'deleted_at' } = {}) {
  assertSafeIdentifier(table);
  assertSafeIdentifier(column);
  const days = Number(olderThanDays);
  if (!Number.isFinite(days) || days < 0) throw new TypeError('purgeDeleted: olderThanDays must be >= 0');
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return Number((await asyncDb(db).run(`DELETE FROM ${table} WHERE ${column} IS NOT NULL AND ${column} < ?`, [cutoff])).changes);
}

/** SQLite only (the 12-step procedure). Same contract as `rebuildTable`. @returns {Promise<{rows:number}>} */
export async function rebuildTableAsync(db, table, createSql, { copy = {} } = {}) {
  assertSafeIdentifier(table);
  const a = asyncDb(db);
  onlySqlite(a, 'rebuildTable');
  const tmp = `${table}__new`;
  const head = new RegExp(`^\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["\`\\[]?${table}["\`\\]]?\\s*\\(`, 'i');
  if (!head.test(createSql)) throw new TypeError(`rebuildTable: createSql must start with CREATE TABLE ${table} (`);
  if (!(await a.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]))) {
    throw new Error(`rebuildTable: table "${table}" does not exist`);
  }
  for (const col of Object.keys(copy)) assertSafeIdentifier(col, 'column');

  const fkWasOn = Number((await a.get('PRAGMA foreign_keys')).foreign_keys) === 1;
  if (fkWasOn) await a.exec('PRAGMA foreign_keys = OFF');
  try {
    return await a.transaction(async (tx) => {
      const extras = await tx.all(`SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL`, [table]);
      await tx.exec(`DROP TABLE IF EXISTS ${tmp}`);
      await tx.exec(createSql.replace(head, (m) => m.replace(new RegExp(`${table}`, 'i'), tmp)));
      const oldCols = new Set((await tx.all(`PRAGMA table_info(${table})`)).map((c) => c.name));
      const newCols = (await tx.all(`PRAGMA table_info(${tmp})`)).map((c) => c.name);
      const targets = [];
      const sources = [];
      for (const c of newCols) {
        if (Object.hasOwn(copy, c)) { targets.push(c); sources.push(copy[c]); }
        else if (oldCols.has(c)) { targets.push(c); sources.push(c); }
      }
      if (targets.length === 0) throw new Error('rebuildTable: no column to copy');
      const rows = Number((await tx.run(`INSERT INTO ${tmp} (${targets.join(', ')}) SELECT ${sources.join(', ')} FROM ${table}`)).changes);
      await tx.exec(`DROP TABLE ${table}`);
      await tx.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
      for (const e of extras) await tx.exec(e.sql);
      const bad = await tx.all('PRAGMA foreign_key_check');
      if (bad.length > 0) throw new Error(`rebuildTable: foreign key violations after rebuilding ${table} (${bad.length})`);
      return { rows };
    });
  } finally {
    if (fkWasOn) await a.exec('PRAGMA foreign_keys = ON');
  }
}
