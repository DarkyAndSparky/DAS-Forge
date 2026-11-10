import { runMigrations, migrationStatus } from '../migrator.js';
import { log } from '../../audit/log.js';
import { cliActor } from '../actor.js';

/**
 * `app migrate` and `app migrate status`.
 *
 * @param {object} cli
 * @param {object} opts
 * @param {import('../../database/adapter.js')} opts.db
 * @param {string} opts.migrationsDir
 * @param {string|null} [opts.backupDir] - where the pre-migration copy goes (`migrate --no-backup` skips it, and that is audited)
 */
export function registerMigrateCommands(cli, { db, migrationsDir, backupDir = null }) {
  cli.command('migrate', {
    description: 'Apply all pending database migrations',
    usage: '[--no-backup]',
    examples: ['migrate', 'migrate --no-backup'],
    async handler({ flags }) {
      const { applied, backup } = await runMigrations(db, migrationsDir, {
        backupDir,
        skipBackup: flags['no-backup'] === true,
        onBackup: (e) => auditBackup(db, e),
      });
      // eslint-disable-next-line no-console
      if (backup) console.log(`Database copy before migrating: ${backup}`);
      if (applied.length === 0) {
        // eslint-disable-next-line no-console
        console.log('No pending migrations.');
      } else {
        // eslint-disable-next-line no-console
        console.log(`Applied ${applied.length} migration(s):`);
        for (const m of applied) {
          // eslint-disable-next-line no-console
          console.log(`  - ${m.name}`);
        }
      }
      return 0;
    },
  });

  cli.command('migrate status', {
    description: 'List migrations and whether each has been applied',
    usage: '',
    examples: ['migrate status'],
    handler() {
      const status = migrationStatus(db, migrationsDir);
      if (status.length === 0) {
        // eslint-disable-next-line no-console
        console.log('No migration files found.');
        return 0;
      }
      for (const m of status) {
        // eslint-disable-next-line no-console
        console.log(`  [${m.applied ? 'x' : ' '}] ${m.name}${m.modified ? '  (MODIFIED after apply!)' : ''}`);
      }
      return 0;
    },
  });
}

/** The audit table may not exist yet (a fresh database): then there is nothing to write to, and that is fine. */
export function auditBackup(db, e) {
  try {
    log(db, { actor: cliActor(), action: `db.premigrate.${e.status}`, entity: 'database', result: e.status === 'failed' ? 'failure' : 'success', meta: { pending: e.pending, ...(e.file ? { file: e.file } : {}), ...(e.error ? { error: e.error } : {}) } });
  } catch { /* no audit table yet */ }
}
