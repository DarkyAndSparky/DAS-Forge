import { migrationStatus } from '../../cli/migrator.js';

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
    const rows = db.all('PRAGMA integrity_check');
    const ok = rows.length === 1 && Object.values(rows[0])[0] === 'ok';
    results.push({
      name: 'Integrity',
      status: ok ? 'ok' : 'fail',
      message: ok ? 'integrity OK' : rows.map((r) => Object.values(r)[0]).join('; '),
    });
  } catch (err) {
    results.push({ name: 'Integrity', status: 'fail', message: err.message });
  }

  if (migrationsDir) {
    try {
      const status = migrationStatus(db, migrationsDir);
      const pending = status.filter((m) => !m.applied);
      results.push({
        name: 'Migrations',
        status: pending.length === 0 ? 'ok' : 'fail',
        message:
          pending.length === 0
            ? `${status.length} applied, 0 pending`
            : `${pending.length} pending - run \`migrate\``,
      });
    } catch (err) {
      results.push({ name: 'Migrations', status: 'warn', message: err.message });
    }
  }

  return results;
}
