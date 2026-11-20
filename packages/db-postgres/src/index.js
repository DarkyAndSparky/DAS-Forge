/**
 * PostgreSQL driver (ADR-0010). `createPostgresDatabase()` gives the asynchronous database contract of `@das-forge/core`
 * (`get / all / run / exec / transaction`, `dialect: 'postgres'`) over a `pg` pool, so every module that works through
 * `asyncDb(db)` works on PostgreSQL without a change.
 *
 * - SQL written for the core (`?` placeholders, SQLite flavour) is translated by the core dialect layer before each statement.
 * - `run()` returns `{ changes, lastInsertRowid }` like the SQLite adapter: an `INSERT` into a table that has an `id` column gets
 *   `RETURNING id` added.
 * - bigint columns (`COUNT(*)`, `BIGINT`) come back as JavaScript numbers.
 * - Transactions use one pooled connection; code inside the transaction (also after an `await`) is recognised through
 *   AsyncLocalStorage and talks to that connection. Nested transactions are savepoints. `immediate` and `exclusive` modes take a
 *   transaction-level advisory lock, the PostgreSQL counterpart of SQLite's single writer, so "read, decide, write" stays safe
 *   across processes.
 * - Copies are made with `pg_dump` (`snapshotToAsync`), they need the PostgreSQL client tools on the host.
 *
 * `pg` is a peer dependency: install it next to this package, or pass your own pool (`options.pool`) or module (`options.pg`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { translate } from '@das-forge/core/database';

const run = promisify(execFile);
const MODES = ['deferred', 'immediate', 'exclusive'];
const LOCK_KEY = 'das-forge:writer';
const INT8 = 20;

/**
 * The core recognises a violated constraint by the SQLite wording ("UNIQUE constraint failed: users.username"), so a PostgreSQL
 * error is given the same message; the original text stays in `detail`, the SQLSTATE in `code`, the original error in `cause`.
 */
export function mapError(err) {
  const keyColumns = /^Key \(([^)]+)\)=/.exec(String(err?.detail ?? ''))?.[1]?.split(/,\s*/);
  const columns = keyColumns ?? [err?.column].filter(Boolean);
  const where = columns.length > 0 && err?.table ? columns.map((c) => `${err.table}.${c}`).join(', ') : err?.table || err?.constraint || '';
  const wording = {
    23505: 'UNIQUE constraint failed',
    23503: 'FOREIGN KEY constraint failed',
    23502: 'NOT NULL constraint failed',
    23514: 'CHECK constraint failed',
  }[err?.code];
  if (!wording) return err;
  return Object.assign(new Error(`${wording}${where ? `: ${where}` : ''}`, { cause: err }), { code: err.code, detail: err.detail ?? err.message, constraint: err.constraint });
}

const clean = (params) => (params ?? []).map((v) => (v === undefined ? null : typeof v === 'bigint' ? v.toString() : v));
const insertTable = (sql) => /^\s*INSERT\s+INTO\s+("?)([A-Za-z_][\w$]*)\1/i.exec(sql)?.[2]?.toLowerCase() ?? null;
const hasReturning = (sql) => /\bRETURNING\b/i.test(sql);

/** Connection settings of a `postgres://user:password@host:port/db` URL as the PG* variables the client tools read. */
export function connectionEnv(connectionString) {
  const u = new URL(connectionString);
  const env = {};
  if (u.hostname) env.PGHOST = decodeURIComponent(u.hostname);
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  if (u.pathname.length > 1) env.PGDATABASE = decodeURIComponent(u.pathname.slice(1));
  const sslmode = u.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

async function loadPg(options) {
  if (options.pg) return options.pg;
  try {
    // @ts-ignore -- pg is an optional peer dependency: it may not be installed (the error below says what to do)
    const mod = await import('pg');
    return mod.default ?? mod;
  } catch (cause) {
    throw new Error('@das-forge/db-postgres needs the "pg" package: run `npm install pg`, or pass `pg` / `pool` in the options.', { cause });
  }
}

/**
 * @param {object} options
 * @param {string} [options.connectionString] - postgres://user:password@host:5432/database
 * @param {object} [options.pool] - a ready `pg` Pool (or anything with `query()`, `connect()` and `end()`); it is not closed by `close()` unless `ownsPool`
 * @param {object} [options.pg] - the `pg` module (default: `import('pg')`)
 * @param {number} [options.max=10] - pool size
 * @param {boolean|object} [options.ssl]
 * @param {number} [options.statementTimeoutMs] - `statement_timeout` of every connection
 * @param {string} [options.applicationName='das-forge']
 * @returns {Promise<object>} the asynchronous database; `db.async` is the same object, so `asyncDb(db)` returns it unchanged
 */
export async function createPostgresDatabase(options = {}) {
  let pool = options.pool;
  let ownsPool = options.ownsPool ?? false;
  if (!pool) {
    if (!options.connectionString) throw new TypeError('createPostgresDatabase: connectionString or pool is required');
    const pg = await loadPg(options);
    const Pool = pg.Pool ?? pg.default?.Pool;
    const defaults = pg.types;
    pool = new Pool({
      connectionString: options.connectionString,
      max: options.max ?? 10,
      ssl: options.ssl,
      application_name: options.applicationName ?? 'das-forge',
      statement_timeout: options.statementTimeoutMs,
      types: defaults
        ? { getTypeParser: (oid, format) => (oid === INT8 ? (text) => Number(text) : defaults.getTypeParser(oid, format)) }
        : undefined,
    });
    ownsPool = true;
  }

  const als = new AsyncLocalStorage();
  const idColumn = new Map(); // table -> has an "id" column (only remembered once the table exists)
  let seq = 0;

  const executor = () => als.getStore()?.client ?? pool;
  const query = (text, params) => executor().query(text, clean(params)).catch((err) => { throw mapError(err); });

  async function hasId(table) {
    if (idColumn.has(table)) return idColumn.get(table);
    const r = await query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
      [table]
    );
    if (r.rows.length === 0) return false;
    const yes = r.rows.some((c) => c.column_name === 'id');
    idColumn.set(table, yes);
    return yes;
  }

  const db = {
    dialect: 'postgres',
    pool,
    async get(sql, params = []) {
      return (await query(translate(sql, 'postgres'), params)).rows[0];
    },
    async all(sql, params = []) {
      return (await query(translate(sql, 'postgres'), params)).rows;
    },
    async run(sql, params = []) {
      let text = translate(sql, 'postgres');
      const table = insertTable(text);
      const wantsId = table !== null && !hasReturning(text) && (await hasId(table));
      if (wantsId) text = `${text.replace(/;?\s*$/, '')} RETURNING id`;
      const r = await query(text, params);
      return { changes: r.rowCount ?? 0, lastInsertRowid: wantsId ? Number(r.rows[0]?.id ?? 0) : 0 };
    },
    async exec(sql) {
      await executor().query(translate(sql, 'postgres')).catch((err) => { throw mapError(err); });
    },
    async transaction(fn, { mode = 'deferred' } = {}) {
      if (typeof fn !== 'function') throw new TypeError('transaction: a function is required');
      if (!MODES.includes(mode)) throw new TypeError(`transaction: unknown mode "${mode}"`);
      const open = als.getStore();
      if (open) {
        const sp = `das_asp_${++seq}`;
        await open.client.query(`SAVEPOINT ${sp}`);
        try {
          const r = await fn(db);
          await open.client.query(`RELEASE SAVEPOINT ${sp}`);
          return r;
        } catch (err) {
          try { await open.client.query(`ROLLBACK TO SAVEPOINT ${sp}`); await open.client.query(`RELEASE SAVEPOINT ${sp}`); } catch { /* never hide the first error */ }
          throw err;
        }
      }
      const client = await pool.connect();
      let failure = null;
      try {
        return await als.run({ client }, async () => {
          await client.query('BEGIN');
          try {
            if (mode !== 'deferred') await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
            const r = await fn(db);
            await client.query('COMMIT');
            return r;
          } catch (err) {
            failure = err;
            try { await client.query('ROLLBACK'); } catch { /* never hide the first error */ }
            throw err;
          }
        });
      } finally {
        // a connection that failed in the middle of a transaction is thrown away instead of going back to the pool
        client.release(failure && /connection|terminated|ECONN/i.test(String(failure.message)) ? failure : undefined);
      }
    },
    /** `SELECT 1`: is the server reachable? */
    async ping() {
      await query('SELECT 1');
      return true;
    },
    /**
     * A copy of the database made with `pg_dump` (custom format, restorable with `pg_restore`); with `check`, the file is read back
     * with `pg_restore --list`. Needs the PostgreSQL client tools and the `connectionString` option.
     * @returns {Promise<{ file: string, integrityOk?: boolean }>}
     */
    async snapshotToAsync(dest, { check = false } = {}) {
      if (!options.connectionString) throw new Error('snapshotToAsync needs the connectionString option (pg_dump connects on its own)');
      const env = { ...process.env, ...connectionEnv(options.connectionString) };
      await run(options.pgDump ?? 'pg_dump', ['--format=custom', '--no-owner', '--file', dest], { env });
      if (!check) return { file: dest };
      try {
        await run(options.pgRestore ?? 'pg_restore', ['--list', dest], { env, maxBuffer: 64 * 1024 * 1024 });
        return { file: dest, integrityOk: true };
      } catch {
        return { file: dest, integrityOk: false };
      }
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
  db.async = db;
  return db;
}
