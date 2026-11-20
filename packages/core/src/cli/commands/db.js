import { statSync } from 'node:fs';
import { migrationStatusAsync } from '../migrator.js';
import { asyncDb } from '../../database/async.js';
import { copyDatabaseAsync } from '../../database/copy.js';
import { createDatabase } from '../../database/factory.js';

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
 * @param {object} opts.db
 * @param {string} opts.migrationsDir
 * @param {string} opts.dbFilePath - for file size reporting
 */
export function registerDbCommands(cli, { db, migrationsDir, dbFilePath }) {
  const adb = asyncDb(db);
  cli.command('db status', {
    description: 'Database connection, migration, and file-size summary',
    async handler({ flags }) {
      let connection = 'ok';
      try {
        await adb.get('SELECT 1 AS ok');
      } catch (err) {
        connection = `error: ${err.message}`;
      }

      const status = await migrationStatusAsync(adb, migrationsDir);
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
    async handler({ flags }) {
      if (adb.dialect === 'postgres') {
        // eslint-disable-next-line no-console
        console.error('integrity_check is an SQLite command; for PostgreSQL use `pg_amcheck` / `pg_dump` from the database host.');
        return 1;
      }
      const rows = await adb.all('PRAGMA integrity_check');
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
        await adb.exec('VACUUM');
        // eslint-disable-next-line no-console
        console.log('VACUUM complete.');
      }

      return ok ? 0 : 1;
    },
  });

  cli.command('db copy', {
    description: 'Copy every table of this SQLite database into PostgreSQL (the target must be empty; create its tables and triggers first)',
    usage: '--to ENV_NAME [--dry-run] [--tables a,b] [--skip a,b]',
    async handler({ flags }) {
      const envName = typeof flags.to === 'string' ? flags.to : '';
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
        // eslint-disable-next-line no-console
        console.error('db copy: --to ENV_NAME is required: the name of the environment variable that holds the PostgreSQL connection string (not the string itself).');
        return 1;
      }
      if (adb.dialect === 'postgres') {
        // eslint-disable-next-line no-console
        console.error('db copy: this installation already runs on PostgreSQL; the source must be an SQLite database.');
        return 1;
      }
      const list = (v) => (typeof v === 'string' && v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
      let target;
      try {
        target = await createDatabase({ driver: 'postgres', url: `env:${envName}` });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`db copy: ${err.message}`);
        return 1;
      }
      try {
        const report = await copyDatabaseAsync(db, target, {
          tables: list(flags.tables), skip: list(flags.skip) ?? [], dryRun: flags['dry-run'] === true,
          onProgress: ({ table, copied, total }) => { if (copied === total && !flags.json) console.log(`  ${table}: ${copied}/${total}`); }, // eslint-disable-line no-console
        });
        if (flags.json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(report));
        } else {
          // eslint-disable-next-line no-console
          console.log(`${report.dryRun ? 'Check only (nothing written): ' : ''}${report.tables.length} tables, ${report.tables.reduce((n, t) => n + t.rows, 0)} rows`);
          for (const k of report.skipped) console.log(`  not copied: ${k.name} (${k.reason})`); // eslint-disable-line no-console
          for (const p of report.problems) console.error(`  PROBLEM: ${p}`); // eslint-disable-line no-console
        }
        return report.ok ? 0 : 1;
      } finally {
        await target.close?.();
      }
    },
  });
}
