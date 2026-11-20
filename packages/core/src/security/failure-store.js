/**
 * Persistent storage of sign-in failure counters (A2): the lock-out of an account or an address now survives a restart of
 * the application, and several processes on one database see each other's locks.
 *
 * Table `auth_failure_counters(scope, key, failures, locked_until, last_failure_at)`, time in UTC milliseconds, one row per
 * counter; `scope` names the tracker ('login-pair', 'login-user', 'login-ip', 'mfa'). Created on first use. Runs through
 * `asyncDb`, so SQLite and PostgreSQL alike; the statements use only `?`, `ON CONFLICT ... DO UPDATE` and `CASE`.
 *
 * Writing keeps the larger value of each column (a second process cannot lower a lock another one set); the
 * tracker (`http/rate-limit.js`) decides when to write and merges what it reads.
 */
import { asyncDb } from '../database/async.js';

/** @param {object} db @param {{scope: string}} o */
export function createFailureStore(db, { scope }) {
  if (!scope || typeof scope !== 'string') throw new TypeError('createFailureStore: scope is required');
  const a = asyncDb(db);
  let ready = null;
  const ensure = () => (ready ??= (async () => {
    await a.exec(`CREATE TABLE IF NOT EXISTS auth_failure_counters (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      failures INTEGER NOT NULL,
      locked_until BIGINT NOT NULL DEFAULT 0,
      last_failure_at BIGINT NOT NULL,
      PRIMARY KEY (scope, key)
    )`);
    await a.exec('CREATE INDEX IF NOT EXISTS idx_auth_failure_counters_locked ON auth_failure_counters (locked_until)');
  })().catch((err) => { ready = null; throw err; }));

  const big = (v) => Number(v ?? 0);
  const up = (col) => `${col} = CASE WHEN excluded.${col} > auth_failure_counters.${col} THEN excluded.${col} ELSE auth_failure_counters.${col} END`;

  return {
    scope,
    /** @returns {Promise<{key:string, failures:number, lockedUntil:number, lastFailureAt:number}[]>} */
    async load() {
      await ensure();
      const rows = await a.all('SELECT key, failures, locked_until, last_failure_at FROM auth_failure_counters WHERE scope = ?', [scope]);
      return rows.map((r) => ({ key: String(r.key), failures: big(r.failures), lockedUntil: big(r.locked_until), lastFailureAt: big(r.last_failure_at) }));
    },
    /** Writes (insert or raise) the given counters in one transaction. */
    async save(entries) {
      if (entries.length === 0) return;
      await ensure();
      await a.transaction(async () => {
        for (const e of entries) {
          await a.run(
            `INSERT INTO auth_failure_counters (scope, key, failures, locked_until, last_failure_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (scope, key) DO UPDATE SET ${up('failures')}, ${up('locked_until')}, ${up('last_failure_at')}`,
            [scope, e.key, e.failures, e.lockedUntil, e.lastFailureAt],
          );
        }
      });
    },
    async remove(keys) {
      if (keys.length === 0) return;
      await ensure();
      await a.transaction(async () => { for (const k of keys) await a.run('DELETE FROM auth_failure_counters WHERE scope = ? AND key = ?', [scope, k]); });
    },
    async removePrefix(prefix) {
      await ensure();
      await a.run('DELETE FROM auth_failure_counters WHERE scope = ? AND substr(key, 1, ?) = ?', [scope, prefix.length, prefix]);
    },
    /** Deletes counters that are not locked and have been quiet since `quietBefore` (ms). @returns {Promise<void>} */
    async purge({ now, quietBefore }) {
      await ensure();
      await a.run('DELETE FROM auth_failure_counters WHERE scope = ? AND locked_until <= ? AND last_failure_at < ?', [scope, now, quietBefore]);
    },
  };
}
