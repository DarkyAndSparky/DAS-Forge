import { statSync } from 'node:fs';
import { migrationStatus } from '../migrator.js';

/**
 * `app db status [--json]` and `app db integrity`. Named `db ...` per
 * §4.1, DELIBERATELY separate from the pre-existing `migrate` / `migrate
 * status` commands (migrate.js) rather than folding into a renamed `db
 * migrate` - renaming an already-shipped command would break
 * examples/workshop's bin/app.js and any script an operator already
 * wrote against it. Both command groups exist side by side; `migrate
 * status` is the narrower "which migrations have run", `db status` is
 * the broader "is this database healthy" (file size + the same info).
 *
 * `db integrity [--repair]`: node:sqlite has no built-in corruption
 * *repair* (PRAGMA integrity_check only detects problems, it doesn't
 * fix them - the only real "repair" for sqlite is restoring a known-
 * good backup). So `--repair` does NOT attempt a repair; it runs
 * VACUUM, which can clear up a specific sub-class of issues (free-page
 * bloat, some index inconsistencies) but is not a cure for structural
 * corruption. This is stated plainly in the command's own output
 * instead of a flag that silently does less than its name implies.
 *
 * @param {object} cli
 * @param {object} opts
 * @param {import('../../database/adapter.js')} opts.db
 * @param {string} opts.migrationsDir
 * @param {string} opts.dbFilePath - for file size reporting
 */
export function registerDbCommands(cli, { db, migrationsDir, dbFilePath }) {
  cli.command('db status', {
    description: 'Database connection, migration, and file-size summary',
    handler({ flags }) {
      let connection = 'ok';
      try {
        db.get('SELECT 1 AS ok');
      } catch (err) {
        connection = `error: ${err.message}`;
      }

      const status = migrationStatus(db, migrationsDir);
      const pending = status.filter((m) => !m.applied);

      let sizeBytes = null;
      try {
        sizeBytes = statSync(dbFilePath).size;
      } catch {
        // :memory: or not-yet-created - leave as null, not an error
      }

      const result = {
        connection,
        migrations: { applied: status.length - pending.length, pending: pending.length },
        sizeBytes,
      };

      if (flags.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result));
      } else {
        // eslint-disable-next-line no-console
        console.log(`connection: ${result.connection}`);
        // eslint-disable-next-line no-console
        console.log(`migrations: ${result.migrations.applied} applied, ${result.migrations.pending} pending`);
        // eslint-disable-next-line no-console
        console.log(`file size: ${sizeBytes != null ? `${(sizeBytes / 1024).toFixed(1)} KB` : 'n/a'}`);
      }

      return connection === 'ok' && pending.length === 0 ? 0 : 1;
    },
  });

  cli.command('db integrity', {
    description: 'Run PRAGMA integrity_check (--repair additionally runs VACUUM - does not fix structural corruption)',
    handler({ flags }) {
      const rows = db.all('PRAGMA integrity_check');
      const ok = rows.length === 1 && Object.values(rows[0])[0] === 'ok';

      if (ok) {
        // eslint-disable-next-line no-console
        console.log('✓ integrity OK');
      } else {
        // eslint-disable-next-line no-console
        console.error('✗ integrity problems found:');
        for (const row of rows) {
          // eslint-disable-next-line no-console
          console.error(`  - ${Object.values(row)[0]}`);
        }
        // eslint-disable-next-line no-console
        console.error(
          '\nnode:sqlite has no automatic corruption repair. The only reliable fix ' +
            'is restoring a known-good backup (`app backup restore <file>`).'
        );
      }

      if (flags.repair) {
        // eslint-disable-next-line no-console
        console.log(ok ? 'Running VACUUM anyway (--repair was passed)...' : 'Running VACUUM (will not fix structural corruption above)...');
        db.exec('VACUUM');
        // eslint-disable-next-line no-console
        console.log('VACUUM complete.');
      }

      return ok ? 0 : 1;
    },
  });
}
