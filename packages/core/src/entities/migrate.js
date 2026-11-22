/**
 * Table changes from the entity descriptor (ADR-0012, B3). The descriptor is the truth about the table; this module compares it
 * with the database and plans the difference. It only ever ADDS: a new table, a new column, a new index. It never drops or
 * rewrites anything; what it will not do is reported as a warning for a person to decide.
 *
 *   const plan = await planEntitySync(db, entities);     // nothing is changed
 *   plan.statements   // what would run, in order
 *   plan.warnings     // [{ entity, code, column?, message }]
 *   await applyEntitySync(db, plan);                      // runs the statements in one transaction
 *
 * Warnings: `column_not_in_descriptor` (a column of the table the descriptor does not know; kept),
 * `required_added_nullable` (a required field was added to an existing table: the column is added without NOT NULL, fill it and
 * tighten by hand), `type_differs` (the column has another kind of type than the descriptor says; not changed).
 */
import { asyncDb } from '../database/async.js';

const affinity = (t) => {
  const s = String(t).toLowerCase();
  if (/int|serial/.test(s)) return 'integer';
  if (/char|text|clob|uuid|json/.test(s) || s === '') return 'text';
  if (/real|floa|doub|numeric|decimal/.test(s)) return 'real';
  return s;
};

async function tableColumns(a, table) {
  if (a.dialect === 'postgres') {
    const rows = await a.all('SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?', [table]);
    return rows.map((r) => ({ name: r.name, type: r.type }));
  }
  const rows = await a.all(`SELECT name, type FROM pragma_table_info(?)`, [table]);
  return rows.map((r) => ({ name: r.name, type: r.type }));
}

async function indexNames(a, table) {
  if (a.dialect === 'postgres') return new Set((await a.all('SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ?', [table])).map((r) => r.name));
  return new Set((await a.all('SELECT name FROM pragma_index_list(?)', [table])).map((r) => r.name));
}

/** @param {object} db database (sync adapter or async) @param {object[]|{entities: object[]}} entities @returns {Promise<{statements: string[], warnings: object[], created: string[], altered: string[]}>} */
export async function planEntitySync(db, entities) {
  const a = asyncDb(db);
  const list = Array.isArray(entities) ? entities : entities.entities;
  const plan = { statements: [], warnings: [], created: [], altered: [] };
  for (const e of list) {
    const have = await tableColumns(a, e.table);
    const stmts = e.ddl();
    if (have.length === 0) { plan.statements.push(...stmts); plan.created.push(e.name); continue; }
    const byName = new Map(have.map((c) => [c.name, c]));
    const want = e.columns();
    let changed = false;
    for (const c of want) {
      const found = byName.get(c.name);
      if (!found) {
        const needsDefault = c.notNull && !c.hasDefault;
        const sql = needsDefault ? c.sql.replace(/ NOT NULL/, '') : c.sql;
        plan.statements.push(`ALTER TABLE ${e.table} ADD COLUMN ${sql}`);
        if (needsDefault) plan.warnings.push({ entity: e.name, code: 'required_added_nullable', column: c.name, message: `column ${c.name} was added without NOT NULL: fill the existing rows, then tighten it by hand` });
        changed = true;
      } else if (c.name !== 'id' && affinity(c.sql.split(/\s+/)[1]) !== affinity(found.type)) {
        plan.warnings.push({ entity: e.name, code: 'type_differs', column: c.name, message: `column ${c.name} is ${found.type} in the database, the descriptor says ${c.sql.split(/\s+/)[1]}; not changed` });
      }
    }
    const known = new Set(want.map((c) => c.name));
    for (const c of have) if (!known.has(c.name)) plan.warnings.push({ entity: e.name, code: 'column_not_in_descriptor', column: c.name, message: `column ${c.name} is not in the descriptor; kept as it is` });
    const idx = await indexNames(a, e.table);
    for (const s of stmts.slice(1)) {
      const m = /INDEX (?:IF NOT EXISTS )?(\S+)/.exec(s);
      if (m && !idx.has(m[1])) { plan.statements.push(s); changed = true; }
    }
    if (changed) plan.altered.push(e.name);
  }
  return plan;
}

/** Runs a plan in one transaction (DDL is transactional on SQLite and PostgreSQL). Returns how many statements ran. */
export async function applyEntitySync(db, plan) {
  const a = asyncDb(db);
  if (plan.statements.length === 0) return 0;
  await a.transaction(async (q) => { for (const s of plan.statements) await q.exec(s); });
  return plan.statements.length;
}
