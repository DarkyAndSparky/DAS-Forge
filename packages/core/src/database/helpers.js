import { assertSafeIdentifier } from './identifiers.js';
import { buildWhere } from './query-by-example.js';

/**
 * INSERT ... ON CONFLICT(<conflictColumns>) DO UPDATE (audit B17).
 * Identifiers are validated; values are bound parameters. `updateColumns`
 * defaults to every non-conflict column. Needs a UNIQUE/PRIMARY KEY on the
 * conflict columns (SQLite requirement).
 * @returns {{changes:number, lastInsertRowid:number|bigint}}
 */
export function upsert(db, table, row, conflictColumns, { updateColumns } = {}) {
  assertSafeIdentifier(table);
  const cols = Object.keys(row);
  if (cols.length === 0) throw new TypeError('upsert: row must have at least one column');
  cols.forEach((c) => assertSafeIdentifier(c));
  conflictColumns.forEach((c) => assertSafeIdentifier(c));
  const update = (updateColumns ?? cols.filter((c) => !conflictColumns.includes(c))).map((c) => assertSafeIdentifier(c) ?? c);
  const set = update.length
    ? update.map((c) => `${c} = excluded.${c}`).join(', ')
    : null;
  const sql =
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ` +
    `ON CONFLICT(${conflictColumns.join(', ')}) ` +
    (set ? `DO UPDATE SET ${set}` : 'DO NOTHING');
  return db.run(sql, cols.map((c) => row[c]));
}

/**
 * Idempotent `ALTER TABLE ... ADD COLUMN` for migrations (audit B17).
 * `definition` is raw SQL type/constraints written by the developer
 * (e.g. "TEXT NOT NULL DEFAULT ''") - never pass user input here.
 * @returns {boolean} true if the column was added
 */
export function addColumnIfMissing(db, table, column, definition) {
  assertSafeIdentifier(table);
  assertSafeIdentifier(column);
  if (db.all(`PRAGMA table_info(${table})`).some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/**
 * Keeps `updated_at` honest no matter which code path changes a row (audit B17):
 * an AFTER UPDATE trigger stamps the column unless the UPDATE set it itself.
 * Adds the column if missing. Idempotent. Table needs a rowid (any normal table).
 * @returns {boolean} true if the trigger was created now
 */
export function addUpdatedAtTrigger(db, table, { column = 'updated_at' } = {}) {
  assertSafeIdentifier(table);
  assertSafeIdentifier(column);
  addColumnIfMissing(db, table, column, 'TEXT');
  const name = `trg_${table}_${column}`;
  const exists = db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'trigger' AND name = ?`, [name]);
  if (exists) return false;
  db.exec(
    `CREATE TRIGGER ${name} AFTER UPDATE ON ${table} FOR EACH ROW ` +
      `WHEN NEW.${column} IS OLD.${column} ` +
      `BEGIN UPDATE ${table} SET ${column} = ${NOW_SQL} WHERE rowid = NEW.rowid; END`
  );
  return true;
}

/**
 * Prepares a table for soft delete: `deleted_at` column + index. Idempotent.
 * @returns {boolean} true if the column was added
 */
export function addSoftDelete(db, table, { column = 'deleted_at' } = {}) {
  assertSafeIdentifier(table);
  assertSafeIdentifier(column);
  const added = addColumnIfMissing(db, table, column, 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_${column} ON ${table}(${column})`);
  return added;
}

/**
 * Marks matching live rows deleted (sets the column to now). `example` uses
 * queryByExample syntax and MUST NOT be empty (an empty one would hide the table).
 * @returns {number} rows affected
 */
export function softDelete(db, table, example, { column = 'deleted_at' } = {}) {
  assertSafeIdentifier(table);
  assertSafeIdentifier(column);
  const where = buildWhere(example);
  if (!where.sql) throw new TypeError('softDelete: an empty example would delete every row');
  return Number(db.run(`UPDATE ${table} SET ${column} = ${NOW_SQL}${where.sql} AND ${column} IS NULL`, where.params).changes);
}

/** Undoes softDelete for matching rows. @returns {number} rows affected */
export function restoreDeleted(db, table, example, { column = 'deleted_at' } = {}) {
  assertSafeIdentifier(table);
  assertSafeIdentifier(column);
  const where = buildWhere(example);
  if (!where.sql) throw new TypeError('restoreDeleted: an empty example would restore every row');
  return Number(db.run(`UPDATE ${table} SET ${column} = NULL${where.sql} AND ${column} IS NOT NULL`, where.params).changes);
}

/** Permanently removes rows soft-deleted more than `olderThanDays` ago. @returns {number} */
export function purgeDeleted(db, table, { olderThanDays, column = 'deleted_at' } = {}) {
  assertSafeIdentifier(table);
  assertSafeIdentifier(column);
  const days = Number(olderThanDays);
  if (!Number.isFinite(days) || days < 0) throw new TypeError('purgeDeleted: olderThanDays must be >= 0');
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return Number(db.run(`DELETE FROM ${table} WHERE ${column} IS NOT NULL AND ${column} < ?`, [cutoff]).changes);
}

/**
 * Changes a table's definition (drop/rename a column, change a type, add a
 * constraint) with SQLite's documented 12-step procedure, which ALTER TABLE
 * cannot do (audit B17). In one transaction: create `<table>__new` from
 * `createSql`, copy the rows, drop the old table, rename, recreate the
 * table's indexes/triggers, then check foreign keys - a violation rolls
 * everything back and throws.
 *
 * `createSql` is the full `CREATE TABLE <table> (...)` statement for the NEW
 * shape (written by the developer, never from user input). Columns present in
 * both shapes are copied by name; `copy` overrides/adds per new column, e.g.
 * `{ full_name: "first || ' ' || last" }` (SQL expressions over the OLD table).
 * Views that reference the table are not recreated: drop and recreate them in
 * the same migration.
 *
 * @param {object} db
 * @param {string} table
 * @param {string} createSql
 * @param {{copy?: Record<string,string>}} [opts]
 * @returns {{rows: number}} rows copied
 */
export function rebuildTable(db, table, createSql, { copy = {} } = {}) {
  assertSafeIdentifier(table);
  const tmp = `${table}__new`;
  const head = new RegExp(`^\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["\`\\[]?${table}["\`\\]]?\\s*\\(`, 'i');
  if (!head.test(createSql)) throw new TypeError(`rebuildTable: createSql must start with CREATE TABLE ${table} (`);
  if (!db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, [table])) {
    throw new Error(`rebuildTable: table "${table}" does not exist`);
  }
  for (const col of Object.keys(copy)) assertSafeIdentifier(col, 'column');

  // foreign_keys cannot change inside a transaction, so switch it off around the rebuild.
  const fkWasOn = Number(db.get('PRAGMA foreign_keys').foreign_keys) === 1;
  if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF');
  try {
    return db.transaction(() => {
      const extras = db.all(
        `SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL`,
        [table]
      );
      db.exec(`DROP TABLE IF EXISTS ${tmp}`);
      db.exec(createSql.replace(head, (m) => m.replace(new RegExp(`${table}`, 'i'), tmp)));
      const oldCols = new Set(db.all(`PRAGMA table_info(${table})`).map((c) => c.name));
      const newCols = db.all(`PRAGMA table_info(${tmp})`).map((c) => c.name);
      const targets = [];
      const sources = [];
      for (const c of newCols) {
        if (Object.hasOwn(copy, c)) {
          targets.push(c);
          sources.push(copy[c]);
        } else if (oldCols.has(c)) {
          targets.push(c);
          sources.push(c);
        }
      }
      if (targets.length === 0) throw new Error('rebuildTable: no column to copy');
      const rows = Number(db.run(`INSERT INTO ${tmp} (${targets.join(', ')}) SELECT ${sources.join(', ')} FROM ${table}`).changes);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
      for (const e of extras) db.exec(e.sql);
      const bad = db.all('PRAGMA foreign_key_check');
      if (bad.length > 0) throw new Error(`rebuildTable: foreign key violations after rebuilding ${table} (${bad.length})`);
      return { rows };
    });
  } finally {
    if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
  }
}
