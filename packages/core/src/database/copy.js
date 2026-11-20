import { asyncDb } from './async.js';
import { translate } from './dialect.js';
import { columnsAsync, tableExistsAsync } from './helpers-async.js';
import { assertSafeIdentifier } from './identifiers.js';

/**
 * Copies every table of an SQLite database into another database (ADR-0010: moving a running installation from SQLite to
 * PostgreSQL). The source is read as it is; the target must be empty (or the table missing — then it is created from the
 * source's own definition, translated for the target). Each table is copied in one transaction, in an order that respects
 * foreign keys; identity sequences are moved past the copied ids; at the end the row counts are compared.
 *
 * Not copied, and said so in the report: virtual tables (full-text indexes — rebuild them with `createFtsIndexAsync`) and
 * triggers (the application's own `ensure…Async` functions create them; do that on the target BEFORE copying, so that the
 * append-only trigger of the audit journal exists).
 *
 * @param {object} source - the synchronous SQLite adapter (`createSqliteAdapter`)
 * @param {object} target - any database (`createPostgresDatabase`, an adapter): the copy goes through `asyncDb`
 * @param {object} [opts]
 * @param {string[]} [opts.tables] only these tables
 * @param {string[]} [opts.skip] leave these tables out
 * @param {number} [opts.batchSize=500] rows read and written at a time
 * @param {boolean} [opts.createMissing=true] create tables that the target does not have
 * @param {boolean} [opts.dryRun=false] read and check, write nothing
 * @param {(e: {table: string, copied: number, total: number}) => void} [opts.onProgress]
 * @returns {Promise<{ok: boolean, dryRun: boolean, tables: Array<{name: string, rows: number, copied: number, created: boolean}>, skipped: Array<{name: string, reason: string}>, problems: string[]}>}
 */
export async function copyDatabaseAsync(source, target, { tables, skip = [], batchSize = 500, createMissing = true, dryRun = false, onProgress } = {}) {
  if (typeof source?.all !== 'function' || (source.dialect ?? 'sqlite') !== 'sqlite' || source.async === source) {
    throw new TypeError('copyDatabaseAsync: the source must be the synchronous SQLite adapter');
  }
  const to = asyncDb(target);
  const report = { ok: false, dryRun, tables: [], skipped: [], problems: [] };

  const master = source.all("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY rowid");
  const virtual = master.filter((r) => r.type === 'table' && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(r.sql ?? '')).map((r) => r.name);
  const isShadow = (name) => virtual.some((v) => name.startsWith(`${v}_`));
  let names = [];
  for (const r of master.filter((m) => m.type === 'table')) {
    if (virtual.includes(r.name)) { report.skipped.push({ name: r.name, reason: 'virtual table (full-text index): rebuild it on the target' }); continue; }
    if (isShadow(r.name)) { report.skipped.push({ name: r.name, reason: 'internal table of a virtual table' }); continue; }
    if (skip.includes(r.name) || (tables && !tables.includes(r.name))) { report.skipped.push({ name: r.name, reason: 'left out by the options' }); continue; }
    assertSafeIdentifier(r.name, 'table');
    names.push(r.name);
  }
  const triggers = master.filter((m) => m.type === 'trigger').map((m) => m.name);
  if (triggers.length) report.skipped.push({ name: triggers.join(', '), reason: 'triggers are not copied: create them on the target with the application\'s ensure…Async functions' });

  // parents before children
  const parents = new Map(names.map((n) => [n, new Set(source.all(`PRAGMA foreign_key_list(${n})`).map((f) => f.table).filter((p) => p !== n && names.includes(p)))]));
  const ordered = [];
  const visit = (n, trail = []) => {
    if (ordered.includes(n) || trail.includes(n)) return;
    for (const p of parents.get(n)) visit(p, [...trail, n]);
    ordered.push(n);
  };
  names.forEach((n) => visit(n));
  names = ordered;

  // preflight: nothing is written until every table is known to be fine
  const plan = [];
  for (const name of names) {
    const sourceCols = source.all(`PRAGMA table_info(${name})`).map((c) => c.name);
    const exists = await tableExistsAsync(to, name);
    if (!exists && !createMissing) { report.problems.push(`${name}: the table does not exist on the target`); continue; }
    if (exists) {
      const have = new Set((await columnsAsync(to, name)).map((c) => c.name));
      const missing = sourceCols.filter((c) => !have.has(c));
      if (missing.length) { report.problems.push(`${name}: the target has no column ${missing.join(', ')}`); continue; }
      const { n } = await to.get(`SELECT COUNT(*) AS n FROM ${name}`);
      if (Number(n) > 0) { report.problems.push(`${name}: the target table is not empty (${n} rows)`); continue; }
    }
    plan.push({ name, sourceCols, exists, total: Number(source.get(`SELECT COUNT(*) AS n FROM ${name}`).n) });
  }
  if (report.problems.length) return report;
  if (dryRun) {
    report.tables = plan.map((p) => ({ name: p.name, rows: p.total, copied: 0, created: !p.exists }));
    report.ok = true;
    return report;
  }

  for (const p of plan) {
    if (!p.exists) {
      const own = master.find((m) => m.type === 'table' && m.name === p.name);
      await to.exec(translate(own.sql, to.dialect));
      for (const ix of master.filter((m) => m.type === 'index' && m.tbl_name === p.name && m.sql)) await to.exec(translate(ix.sql, to.dialect));
    }
    const cols = p.sourceCols;
    const perStatement = Math.max(1, Math.min(batchSize, Math.floor(30_000 / cols.length)));
    let copied = 0;
    await to.transaction(async () => {
      for (let offset = 0; offset < p.total; offset += batchSize) {
        let rows;
        try { rows = source.all(`SELECT ${cols.join(', ')} FROM ${p.name} ORDER BY rowid LIMIT ? OFFSET ?`, [batchSize, offset]); }
        catch { rows = source.all(`SELECT ${cols.join(', ')} FROM ${p.name} LIMIT ? OFFSET ?`, [batchSize, offset]); } // WITHOUT ROWID
        for (let i = 0; i < rows.length; i += perStatement) {
          const part = rows.slice(i, i + perStatement);
          const one = `(${cols.map(() => '?').join(', ')})`;
          await to.run(`INSERT INTO ${p.name} (${cols.join(', ')}) VALUES ${part.map(() => one).join(', ')}`, part.flatMap((r) => cols.map((c) => value(r[c]))));
        }
        copied += rows.length;
        onProgress?.({ table: p.name, copied, total: p.total });
      }
      if (to.dialect === 'postgres' && cols.includes('id')) {
        const seq = await to.get(`SELECT pg_get_serial_sequence('${p.name}', 'id') AS s`);
        if (seq?.s) await to.get(`SELECT setval('${seq.s}', COALESCE((SELECT MAX(id) FROM ${p.name}), 0) + 1, false) AS v`);
      }
    }, { mode: 'immediate' });
    const { n } = await to.get(`SELECT COUNT(*) AS n FROM ${p.name}`);
    if (Number(n) !== p.total) report.problems.push(`${p.name}: ${p.total} rows in the source, ${n} on the target`);
    report.tables.push({ name: p.name, rows: p.total, copied, created: !p.exists });
  }
  report.ok = report.problems.length === 0;
  return report;
}

function value(v) {
  if (v instanceof Uint8Array && !Buffer.isBuffer(v)) return Buffer.from(v);
  if (typeof v === 'bigint') return Number(v);
  return v;
}
