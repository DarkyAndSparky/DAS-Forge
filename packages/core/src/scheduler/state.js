import { asyncDb, isAsyncOnly } from '../database/async.js';

const STATE_DDL = 'CREATE TABLE IF NOT EXISTS scheduler_state (name TEXT PRIMARY KEY, last_run_at TEXT NOT NULL)';
const GET_SQL = 'SELECT last_run_at FROM scheduler_state WHERE name = ?';
const SET_SQL = `INSERT INTO scheduler_state (name, last_run_at) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at`;

/** The table over `asyncDb`. Call once at start-up, outside a transaction. */
export async function ensureSchedulerStateTableAsync(db) { await asyncDb(db).exec(STATE_DDL); }

/**
 * Persists each job's last run time so missed runs can be caught up after downtime (audit B15).
 * `get`/`set` are synchronous (the scheduler calls them that way); `getAsync`/`setAsync` do the same over `asyncDb`.
 */
export function createDbLastRunStore(db) {
  if (!isAsyncOnly(db)) db.run(STATE_DDL);
  const a = asyncDb(db);
  return {
    get: (name) => db.get(GET_SQL, [name])?.last_run_at ?? null,
    set: (name, iso) => db.run(SET_SQL, [name, iso]),
    getAsync: async (name) => (await a.get(GET_SQL, [name]))?.last_run_at ?? null,
    setAsync: (name, iso) => a.run(SET_SQL, [name, iso]),
  };
}
