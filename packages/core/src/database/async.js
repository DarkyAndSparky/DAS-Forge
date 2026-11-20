import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The asynchronous face of a database (ADR-0010). Every data function of the core is being moved to it, one module at a time,
 * because PostgreSQL (`pg`) can only be asked asynchronously. Until the last module has moved, the same database answers in
 * both ways: `db.get(...)` (old, synchronous, SQLite only) and `asyncDb(db).get(...)` (new, a Promise, any driver).
 *
 * `asyncDb(db)` works for any synchronous adapter, so an SQLite database needs nothing added. A driver that is asynchronous
 * by nature (Postgres) provides its own object with the same methods and returns it from `db.async`.
 *
 * Transactions. An asynchronous transaction has awaits inside it, and on one connection another request could slip its own
 * statements into it. So one transaction runs at a time per database, and a statement that comes from outside it waits until it
 * ends; code inside the transaction (also after an `await`, and in nested calls) is recognised through AsyncLocalStorage and
 * goes straight through. Nested transactions are savepoints.
 *
 * Hybrid period: old synchronous code (`db.run(...)`) does not wait. While the last modules are still moving, keep a
 * transaction short and free of other awaits than database calls; ADR-0010 removes the synchronous methods at the end.
 */
const cache = new WeakMap();
const facades = new WeakSet(); // objects made here: passing one back to asyncDb() returns it unchanged
const MODES = ['deferred', 'immediate', 'exclusive'];

/**
 * True for a database that can only be asked asynchronously (a PostgreSQL driver, or a facade made by `asyncDb`): code that
 * would touch it synchronously at construction time (`ensureTable(db)`) must skip that step; the application creates the tables
 * once at start-up with the `ensure...Async` functions.
 */
export function isAsyncOnly(db) {
  return Boolean(db) && (facades.has(db) || db.async === db || db.dialect === 'postgres');
}

/**
 * @param {object} db - a DatabaseAdapter (synchronous) or an object that already has an `async` property
 * @returns {{ get: Function, all: Function, run: Function, exec: Function, transaction: Function, dialect: string }}
 */
export function asyncDb(db) {
  if (!db || typeof db !== 'object') throw new TypeError('asyncDb: a database is required');
  if (facades.has(db)) return db;
  if (db.async && typeof db.async.transaction === 'function') return db.async;
  let facade = cache.get(db);
  if (!facade) { facade = createFacade(db); cache.set(db, facade); facades.add(facade); }
  return facade;
}

function createFacade(sync) {
  const als = new AsyncLocalStorage();
  let current = null; // the open transaction: { released: Promise, release: () => void }
  let seq = 0;

  const outside = () => current !== null && als.getStore() !== current;
  async function idle() {
    while (outside()) await current.released;
  }
  const call = (name) => async (sql, params = []) => {
    await idle();
    return sync[name](sql, params);
  };

  const facade = {
    dialect: sync.dialect ?? 'sqlite',
    get: call('get'),
    all: call('all'),
    run: call('run'),
    async exec(sql) {
      await idle();
      return sync.exec(sql);
    },
    /**
     * Runs `fn` in a transaction and returns its result; throws (and rolls back) when `fn` throws or rejects.
     * @template T
     * @param {(tx: object) => Promise<T>|T} fn
     * @param {{ mode?: 'deferred'|'immediate'|'exclusive' }} [opts] - only for the outermost call; 'immediate' takes the write lock
     *   at once (use it for read, decide, write)
     * @returns {Promise<T>}
     */
    async transaction(fn, { mode = 'deferred' } = {}) {
      if (typeof fn !== 'function') throw new TypeError('transaction: a function is required');
      if (!MODES.includes(mode)) throw new TypeError(`transaction: unknown mode "${mode}"`);
      if (current !== null && als.getStore() === current) {
        const sp = `das_asp_${++seq}`;
        sync.run(`SAVEPOINT ${sp}`);
        try {
          const r = await fn(facade);
          sync.run(`RELEASE ${sp}`);
          return r;
        } catch (err) {
          try { sync.run(`ROLLBACK TO ${sp}`); sync.run(`RELEASE ${sp}`); } catch { /* never hide the first error */ }
          throw err;
        }
      }
      while (current !== null) await current.released;
      const t = { released: null, release: null };
      t.released = new Promise((resolve) => { t.release = resolve; });
      current = t;
      try {
        return await als.run(t, async () => {
          sync.run(`BEGIN ${mode.toUpperCase()}`);
          try {
            const r = await fn(facade);
            sync.run('COMMIT');
            return r;
          } catch (err) {
            try { sync.run('ROLLBACK'); } catch { /* never hide the first error */ }
            throw err;
          }
        });
      } finally {
        current = null;
        t.release();
      }
    },
  };
  return facade;
}

const ASYNC_METHODS = ['get', 'all', 'run', 'exec', 'transaction'];

/** Throws when the object is not an asynchronous database (the five methods and a `dialect`). */
export function assertAsyncDatabase(candidate) {
  if (!candidate || typeof candidate !== 'object') throw new TypeError('AsyncDatabase must be an object');
  const missing = ASYNC_METHODS.filter((m) => typeof candidate[m] !== 'function');
  if (missing.length > 0) throw new TypeError(`Object does not satisfy AsyncDatabase contract: missing method(s): ${missing.join(', ')}`);
  if (typeof candidate.dialect !== 'string') throw new TypeError('AsyncDatabase needs a `dialect` ("sqlite" or "postgres")');
  return candidate;
}

/**
 * `atomic()` for asynchronous code: a read, decide, write sequence as one transaction that takes the write lock at once, so two
 * processes cannot both read the same state and both act on it.
 * @template T
 * @param {object} db
 * @param {(tx: object) => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export function atomicAsync(db, fn) {
  return asyncDb(db).transaction(fn, { mode: 'immediate' });
}
