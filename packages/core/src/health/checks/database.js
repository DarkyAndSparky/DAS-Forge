import { migrationStatus, migrationStatusAsync } from '../../cli/migrator.js';
import { asyncDb } from '../../database/async.js';

/**
 * Database category: connection, full integrity check (unlike
 * check.js's quick SELECT 1 - doctor is allowed to take real time),
 * and pending-migration count. If the connection itself fails, the
 * later checks are skipped rather than thrown - a dead connection
 * means integrity/migrations can't be meaningfully evaluated either,
 * and doctor should still print a clean partial report, not crash.
 *
 * @param db - a DatabaseAdapter
 * @param {object} [opts]
 * @param {string} [opts.migrationsDir] - omit to skip the Migrations check
 *   (e.g. an app with no migrations directory yet)
 */
const integrityResult = (rows) => {
  const ok = rows.length === 1 && Object.values(rows[0])[0] === 'ok';
  return { name: 'Integrity', status: ok ? 'ok' : 'fail', message: ok ? 'integrity OK' : rows.map((r) => Object.values(r)[0]).join('; ') };
};
const migrationsResult = (status) => {
  const pending = status.filter((m) => !m.applied);
  return {
    name: 'Migrations',
    status: pending.length === 0 ? 'ok' : 'fail',
    message: pending.length === 0 ? `${status.length} applied, 0 pending` : `${pending.length} pending - run \`migrate\``,
  };
};

/**
 * `databaseChecks` over `asyncDb`. The integrity check is SQLite's `PRAGMA integrity_check`; on PostgreSQL it is
 * reported as skipped (the server checks its own storage). `migrationStatusFn(db, dir)` may return a promise;
 * it defaults to the synchronous migrator, which needs a SQLite adapter.
 */
export async function databaseChecksAsync(db, { migrationsDir, migrationStatusFn = migrationStatusAsync } = {}) {
  const a = asyncDb(db);
  const results = [];
  try {
    await a.get('SELECT 1 AS ok');
    results.push({ name: 'Connection', status: 'ok', message: 'connection ok' });
  } catch (err) {
    results.push({ name: 'Connection', status: 'fail', message: err.message });
    return results;
  }
  if (a.dialect === 'sqlite') {
    try { results.push(integrityResult(await a.all('PRAGMA integrity_check'))); } catch (err) { results.push({ name: 'Integrity', status: 'fail', message: err.message }); }
  } else {
    results.push({ name: 'Integrity', status: 'ok', message: `not applicable on ${a.dialect}` });
  }
  if (migrationsDir) {
    try { results.push(migrationsResult(await migrationStatusFn(db, migrationsDir))); } catch (err) { results.push({ name: 'Migrations', status: 'warn', message: err.message }); }
  }
  return results;
}

export function databaseChecks(db, { migrationsDir } = {}) {
  const results = [];

  try {
    db.get('SELECT 1 AS ok');
    results.push({ name: 'Connection', status: 'ok', message: 'connection ok' });
  } catch (err) {
    results.push({ name: 'Connection', status: 'fail', message: err.message });
    return results;
  }

  try {
    results.push(integrityResult(db.all('PRAGMA integrity_check')));
  } catch (err) {
    results.push({ name: 'Integrity', status: 'fail', message: err.message });
  }

  if (migrationsDir) {
    try {
      results.push(migrationsResult(migrationStatus(db, migrationsDir)));
    } catch (err) {
      results.push({ name: 'Migrations', status: 'warn', message: err.message });
    }
  }

  return results;
}
