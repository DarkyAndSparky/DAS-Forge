import path from 'node:path';
import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';

import { assertDatabaseAdapter } from './adapter.js';
import { createFtsIndex } from './fts.js';
import { queryByExample, countByExample, pageByExample } from './query-by-example.js';

/**
 * Plain static import - this is all that's actually needed.
 *
 * History (see docs/roadmap.md §12-15 for the full story): three
 * increasingly elaborate workarounds were tried here first (vitest
 * config `external`, `/* @vite-ignore *\/`, a runtime-computed import
 * specifier) chasing a `Failed to load url sqlite` error under Vitest.
 * None of them were the actual problem. The real cause was a bug in
 * vite-node itself (Vitest's internal module runner): its list of
 * Node builtins that REQUIRE the `node:` prefix (as opposed to `fs`/
 * `path`, which work with or without it) didn't include `node:sqlite`
 * yet, so vite-node's normalizer incorrectly stripped the prefix and
 * tried to load a nonexistent bare `sqlite` package - no amount of
 * cleverness in THIS file could work around a resolver bug in the test
 * runner itself. Fixed upstream in vitest-dev/vitest#7179 (vite-node
 * commit b628464); this package now requires `vitest` ^3.0.0 in
 * package.json, which includes that fix.
 */
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

/**
 * Creates a DatabaseAdapter backed by node:sqlite (DatabaseSync).
 *
 * Per architecture doc: node:sqlite is the confirmed driver (not
 * better-sqlite3) since all 4 real app builds already run on it natively.
 * WAL mode is enabled by default to support the CLI process + running
 * server process both hitting the same DB file (needs real-world
 * validation per the doc's note before Phase 1 contract freeze — this
 * adapter enables WAL but does not itself prove multi-process safety;
 * that's an integration-test concern, see test/sqlite-adapter.test.js).
 *
 * @param {object} opts
 * @param {string} opts.file - path to the sqlite file
 * @param {boolean} [opts.walMode=true]
 * @param {boolean} [opts.readonly=false]
 * @param {number} [opts.busyTimeoutMs=5000] - how long a statement waits
 *   for another connection's lock before SQLITE_BUSY (audit B07: the CLI
 *   running next to the server used to fail immediately)
 * @param {number|null} [opts.fileMode=0o600] - permission bits for the database
 *   file (audit B17: it holds password hashes and personal data). A new file is
 *   created with this mode and SQLite gives `-wal`/`-shm` the same; an existing
 *   file is chmod-ed (best effort). `null` leaves permissions alone. No effect on Windows.
 * @param {boolean} [opts.normalizeValues=false] - opt-in value mapping (audit B17):
 *   writes turn `Date` into an ISO-8601 UTC string and `boolean` into 1/0; reads turn
 *   columns DECLARED as BOOLEAN into `true`/`false` and DATE/DATETIME/TIMESTAMP columns
 *   into `Date` (a stored `YYYY-MM-DD HH:MM:SS` without zone is read as UTC, as SQLite's
 *   own `datetime('now')` writes it; a value that does not parse stays as stored).
 *   Only declared column types count - an expression such as `strftime(...)` has none
 *   and comes back unchanged. Off by default: it changes the types callers receive.
 *   Read mapping needs `StatementSync.columns()` (Node 23.11+; the project targets 26).
 */
export function createSqliteAdapter({ file, walMode = true, readonly = false, busyTimeoutMs = 5000, fileMode = 0o600, statementCacheSize = 128, normalizeValues = false }) {
  if (file !== ':memory:') {
    const dir = path.dirname(path.resolve(file));
    mkdirSync(dir, { recursive: true });
    if (fileMode !== null && !readonly && process.platform !== 'win32') {
      try {
        if (!existsSync(file)) writeFileSync(file, '', { flag: 'wx', mode: fileMode });
        else chmodSync(file, fileMode);
      } catch {
        /* not the owner / read-only volume: permissions stay as they are */
      }
    }
  }

  const db = new DatabaseSync(file, { readOnly: readonly });

  // busy_timeout first: the journal_mode switch below itself needs a lock.
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(Number(busyTimeoutMs)) || 0)};`);
  if (walMode && file !== ':memory:' && !readonly) {
    db.exec('PRAGMA journal_mode = WAL;');
    // NORMAL is the documented safe pairing with WAL: a power cut can
    // lose the last transaction(s) but never corrupts the file.
    db.exec('PRAGMA synchronous = NORMAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');

  // LRU of prepared statements keyed by SQL text (audit B17): preparing is the
  // dominant cost of small queries. DDL clears it so no statement outlives its schema.
  const stmtCache = new Map();
  const cacheStats = { hits: 0, misses: 0 };
  const cacheLimit = Math.max(0, Math.trunc(Number(statementCacheSize)) || 0);
  function prep(sql) {
    if (cacheLimit === 0) return db.prepare(sql);
    let stmt = stmtCache.get(sql);
    if (stmt) {
      cacheStats.hits++;
      stmtCache.delete(sql);
      stmtCache.set(sql, stmt);
      return stmt;
    }
    cacheStats.misses++;
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
    if (stmtCache.size > cacheLimit) stmtCache.delete(stmtCache.keys().next().value);
    return stmt;
  }
  const DDL_RE = /^\s*(CREATE|ALTER|DROP|VACUUM|REINDEX|ANALYZE|ATTACH|DETACH)\b/i;

  const toParams = normalizeValues ? (params) => normalizeParams(params).map(writeValue) : normalizeParams;
  const converters = new WeakMap(); // statement -> per-column converters (computed once)
  function readRow(stmt, row) {
    if (!normalizeValues || row === undefined || row === null) return row;
    let conv = converters.get(stmt);
    if (conv === undefined) {
      conv = typeof stmt.columns === 'function' ? stmt.columns().map((c) => converterFor(c.type)) : [];
      converters.set(stmt, conv);
    }
    if (conv.every((c) => c === null)) return row;
    const names = Object.keys(row);
    conv.forEach((c, i) => {
      if (c !== null && names[i] !== undefined) row[names[i]] = c(row[names[i]]);
    });
    return row;
  }

  function run(sql, params = []) {
    if (DDL_RE.test(sql)) stmtCache.clear();
    return prep(sql).run(...toParams(params));
  }

  function get(sql, params = []) {
    const stmt = prep(sql);
    return readRow(stmt, stmt.get(...toParams(params)));
  }

  function all(sql, params = []) {
    const stmt = prep(sql);
    const rows = stmt.all(...toParams(params));
    return normalizeValues ? rows.map((r) => readRow(stmt, r)) : rows;
  }

  function exec(sql) {
    stmtCache.clear();
    return db.exec(sql);
  }

  let txDepth = 0;
  let savepointSeq = 0;

  /**
   * Runs fn inside a transaction, rolling back on throw. fn receives the
   * same adapter. Calls NEST (audit B06): the outermost call is a real
   * BEGIN/COMMIT, inner calls are SAVEPOINTs, so an inner failure rolls
   * back only the inner work (and, if it propagates, the outer too).
   *
   * fn MUST be synchronous - node:sqlite is synchronous and a COMMIT
   * issued before an async fn finishes would silently commit half the
   * work, so a returned thenable is rolled back and rejected loudly.
   *
   * @param {(tx: object) => any} fn
   * @param {{mode?: 'deferred'|'immediate'|'exclusive'}} [opts] - only
   *   meaningful for the outermost call; 'immediate' takes the write lock
   *   up front (use it for read-then-write sequences like migrations).
   */
  function transaction(fn, { mode = 'deferred' } = {}) {
    if (!['deferred', 'immediate', 'exclusive'].includes(mode)) {
      throw new TypeError(`transaction: unknown mode "${mode}"`);
    }
    const nested = txDepth > 0;
    const savepoint = `das_sp_${++savepointSeq}`;
    db.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN ${mode.toUpperCase()}`);
    txDepth++;
    const rollback = () => {
      try {
        db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      } catch {
        // never mask the original error with a rollback failure
      }
    };
    try {
      const result = fn(adapter);
      if (result && typeof result.then === 'function') {
        // Swallow the promise's own rejection - we are discarding it.
        result.then(undefined, () => {});
        throw new TypeError(
          'transaction(fn): fn returned a Promise. Transactions are synchronous - ' +
            'do the async work before/after, not inside the callback.'
        );
      }
      db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (err) {
      rollback();
      throw err;
    } finally {
      txDepth--;
    }
  }

  /**
   * Writes a consistent snapshot of the live database to `destFile`
   * (which must not exist) using VACUUM INTO - safe while other
   * connections write, unlike copying the file (audit B01). Cannot run
   * inside a transaction.
   */
  function snapshotTo(destFile) {
    if (txDepth > 0) throw new Error('snapshotTo: cannot run inside a transaction');
    db.prepare('VACUUM INTO ?').run(String(destFile));
  }

  /**
   * Like snapshotTo(), but the copy (and, with `check`, `PRAGMA integrity_check` on it) runs in a worker thread, so a
   * big database does not stop the event loop for the length of the copy (audit I03). A file database only: an
   * in-memory one cannot be opened by another thread and falls back to the synchronous copy.
   *
   * @param {string} destFile - must not exist
   * @param {{check?: boolean}} [opts]
   * @returns {Promise<{integrityOk: boolean|null}>} `null` when no check was asked for
   */
  function snapshotToAsync(destFile, { check = true } = {}) {
    if (txDepth > 0) return Promise.reject(new Error('snapshotTo: cannot run inside a transaction'));
    if (file === ':memory:') {
      snapshotTo(destFile);
      return Promise.resolve({ integrityOk: null });
    }
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./snapshot-worker.js', import.meta.url), {
        workerData: { file, dest: destFile, busyTimeoutMs, check },
      });
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      worker.once('message', (m) => (m.ok ? done(resolve, { integrityOk: m.integrityOk }) : done(reject, new Error(m.error))));
      worker.once('error', (e) => done(reject, e));
      worker.once('exit', (code) => done(reject, new Error(`snapshot worker exited with code ${code}`)));
    });
  }

  function close() {
    stmtCache.clear();
    db.close();
  }

  const adapter = {
    run,
    get,
    all,
    exec,
    transaction,
    snapshotTo,
    snapshotToAsync,
    close,
    statementCacheStats: () => ({ size: stmtCache.size, ...cacheStats }),
    createFtsIndex: (table, columns, opts) => createFtsIndex(db, table, columns, opts),
    queryByExample: (table, example, opts) => queryByExample({ all }, table, example, opts),
    countByExample: (table, example, opts) => countByExample({ get }, table, example, opts),
    pageByExample: (table, example, opts) => pageByExample({ all, get }, table, example, opts),
    /** Escape hatch for code that genuinely needs the raw node:sqlite handle. */
    raw: db,
  };

  assertDatabaseAdapter(adapter);
  return adapter;
}

function normalizeParams(params) {
  // node:sqlite's prepare().run()/get()/all() take positional args, not
  // an array — this lets callers pass either `run(sql, [a, b])` or
  // `run(sql, a, b)`-style arrays uniformly.
  return Array.isArray(params) ? params : [params];
}

/** Write side of `normalizeValues`: what node:sqlite cannot bind (boolean, Date) becomes what it can. */
function writeValue(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new RangeError('Invalid Date cannot be stored');
    return v.toISOString();
  }
  return v;
}

/** Read side: a converter for a column by its declared type, or null when the column stays as stored. */
function converterFor(declaredType) {
  const t = String(declaredType ?? '').toUpperCase();
  if (t.includes('BOOL')) return (v) => (v === null || v === undefined ? v : Number(v) !== 0);
  if (t.includes('DATE') || t.includes('TIME')) return toDate;
  return null;
}

function toDate(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d;
  }
  if (typeof v !== 'string') return v;
  let text = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += 'T00:00:00Z';
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) text = `${text.replace(' ', 'T')}Z`; // SQLite writes UTC without a zone
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? v : d;
}
