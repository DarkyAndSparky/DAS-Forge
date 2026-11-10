import { EXIT } from '../exit-codes.js';

/**
 * `app backup {run, list, verify, restore}`. `run` (= §4.1's "create")
 * takes the already-built backup job function from core/scheduler's
 * createBackupJob() rather than building its own - one implementation
 * of "what a backup is" either way. `list`/`verify`/`restore` are thin
 * wrappers over core/scheduler's listBackups()/verifyBackupFile()/
 * restoreBackup() - same split as everywhere else: core does the work,
 * this file only does argv parsing and console output.
 *
 * NOT implemented (§4.1 lists them, this package doesn't have them
 * yet): `backup destinations {list,add,remove,set-primary}` - that's
 * runtime mutation of app.config.js's backup.destinations, which has
 * no config-writing mechanism in core/config yet (loadConfig() only
 * reads). Adding destinations management means deciding how a
 * statically-loaded config file gets safely rewritten from a running
 * process - a real design question, not a one-line gap - so it's left
 * out rather than faked.
 *
 * @param {object} cli
 * @param {object} opts
 * @param {() => Promise<Array>} opts.runBackupFn
 * @param {() => Array} [opts.listBackupsFn]
 * @param {(filePath: string) => {ok:boolean, message:string} | Promise<{ok:boolean, message:string}>} [opts.verifyBackupFn]
 * @param {(filePath: string) => Promise<{ok:boolean, steps:Array}>} [opts.restoreBackupFn]
 */
export function registerBackupCommands(cli, { runBackupFn, listBackupsFn, verifyBackupFn, restoreBackupFn }) {
  cli.command('backup run', {
    description: 'Run a database backup immediately',
    async handler() {
      const results = await runBackupFn();
      // eslint-disable-next-line no-console
      console.log(`Backup complete (${results.length} destination(s)):`);
      for (const r of results) {
        // eslint-disable-next-line no-console
        console.log(`  - ${r.destinationId}: ${r.backupPath}${r.prunedCount ? ` (pruned ${r.prunedCount} old)` : ''}`);
      }
      return 0;
    },
  });

  if (listBackupsFn) {
    cli.command('backup list', {
      description: 'List known backup files',
      async handler({ flags }) {
        const backups = await listBackupsFn();

        if (flags.json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(backups));
          return 0;
        }

        if (backups.length === 0) {
          // eslint-disable-next-line no-console
          console.log('No backups found.');
          return 0;
        }

        for (const b of backups) {
          if (b.supported === false) {
            // eslint-disable-next-line no-console
            console.log(`  [${b.destinationId}] (${b.type}) - listing not implemented for this destination type`);
            continue;
          }
          if (b.error) {
            // eslint-disable-next-line no-console
            console.log(`  [${b.destinationId}] (${b.type}) - cannot list: ${b.error}`);
            continue;
          }
          const sizeKb = (b.sizeBytes / 1024).toFixed(1);
          // eslint-disable-next-line no-console
          console.log(`  [${b.destinationId}] ${b.file}  ${sizeKb} KB  ${b.createdAt}`);
        }
        return 0;
      },
    });
  }

  if (verifyBackupFn) {
    cli.command('backup verify', {
      description: "Verify a backup file's integrity (app backup verify <file>)",
      async handler({ positionals, flags }) {
        const file = positionals[0];
        if (!file) {
          // eslint-disable-next-line no-console
          console.error('Usage: backup verify <file>');
          return EXIT.USAGE;
        }

        const result = await verifyBackupFn(file);
        if (flags.json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result));
        } else {
          // eslint-disable-next-line no-console
          console.log(`${result.ok ? '✓' : '✗'} ${result.message}`);
        }
        return result.ok ? 0 : 1;
      },
    });
  }

  if (restoreBackupFn) {
    cli.command('backup restore', {
      description: 'Restore a backup file over the live database (app backup restore <file> [--yes])',
      async handler({ positionals, flags }) {
        const file = positionals[0];
        if (!file) {
          // eslint-disable-next-line no-console
          console.error('Usage: backup restore <file> [--yes]');
          return EXIT.USAGE;
        }

        if (flags.yes !== true) {
          // eslint-disable-next-line no-console
          console.error(
            `This will OVERWRITE the live database with "${file}".\n` +
              'A safety copy of the current database is kept, but this is still destructive.\n' +
              'Re-run with --yes to proceed.'
          );
          return 1;
        }

        const result = await restoreBackupFn(file);

        for (const step of result.steps) {
          // eslint-disable-next-line no-console
          console.log(`  ${step.ok ? '✓' : '✗'} ${step.name}: ${step.message}`);
        }

        if (flags.json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result));
        }

        return result.ok ? 0 : 1;
      },
    });
  }
}
