import { checkHealth } from '../../health/check.js';

/**
 * `app health [--json]` - quick liveness check, safe to run often. Exit
 * code is 0/1 (ok/degraded), NOT doctor's 0/3 convention - this isn't
 * an environment check, it's "is the process answering right now".
 *
 * @param {object} cli
 * @param {object} opts
 * @param db - a DatabaseAdapter
 * @param {string} [opts.version]
 */
export function registerHealthCommand(cli, { db, version = null }) {
  cli.command('health', {
    description: 'Quick liveness check (process + database)',
    handler({ flags }) {
      const result = checkHealth(db, { version });

      if (flags.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result));
      } else {
        // eslint-disable-next-line no-console
        console.log(`status: ${result.status}  database: ${result.database}  uptime: ${result.uptime}s`);
      }

      return result.status === 'ok' ? 0 : 1;
    },
  });
}
