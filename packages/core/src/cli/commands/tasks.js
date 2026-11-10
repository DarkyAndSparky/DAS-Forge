import { EXIT } from '../exit-codes.js';
import { cliActor } from '../actor.js';

/**
 * `app tasks list [--json]` and `app tasks run <name>`.
 *
 * The scheduler passed in is one the application built for the console: every job registered, none started
 * (no `start()`), so listing never fires anything. `tasks run` executes the job in THIS process, through the same
 * overlap protection and cross-process lock as the server's own run, and writes `cli.tasks.run` to the audit trail.
 * @param {object} opts
 * @param {{listJobs: () => Array<object>, runNow: (name: string) => Promise<void>}} opts.scheduler
 * @param {(entry: object) => void} [opts.auditLog] - e.g. `(e) => audit.log(db, e)`
 */
export function registerTasksCommands(cli, { scheduler, auditLog }) {
  if (!scheduler || typeof scheduler.listJobs !== 'function' || typeof scheduler.runNow !== 'function') {
    throw new TypeError('registerTasksCommands: scheduler with listJobs() and runNow() is required');
  }

  cli.command('tasks list', {
    description: 'List scheduled tasks with their schedule and last run (app tasks list [--json])',
    handler({ flags }) {
      const jobs = scheduler.listJobs();
      if (flags.json) { console.log(JSON.stringify(jobs)); return EXIT.OK; } // eslint-disable-line no-console
      if (!jobs.length) { console.log('No tasks.'); return EXIT.OK; } // eslint-disable-line no-console
      const w = Math.max(...jobs.map((j) => j.name.length));
      for (const j of jobs) {
        // eslint-disable-next-line no-console
        console.log(`  ${j.name.padEnd(w)}  ${String(j.expression ?? 'manual').padEnd(14)}  last: ${j.lastRunAt ?? 'never'}${j.running ? '  (running)' : ''}${j.lastError ? `  error: ${j.lastError}` : ''}`);
      }
      return EXIT.OK;
    },
  });

  cli.command('tasks run', {
    description: 'Run a task now, ignoring its schedule (app tasks run <name>)',
    async handler({ positionals }) {
      const [name] = positionals;
      if (!name) { console.error('Usage: tasks run <name>   (names: app tasks list)'); return EXIT.USAGE; } // eslint-disable-line no-console
      if (!scheduler.listJobs().some((j) => j.name === name)) {
        console.error(`Unknown task "${name}". Known: ${scheduler.listJobs().map((j) => j.name).join(', ') || '(none)'}`); // eslint-disable-line no-console
        return EXIT.USAGE;
      }
      const started = Date.now();
      try {
        await scheduler.runNow(name);
        auditLog?.({ actor: cliActor(), action: 'cli.tasks.run', entity: 'task', entityId: name, meta: { ms: Date.now() - started }, result: 'success' });
        console.log(`Task "${name}" finished in ${Date.now() - started} ms.`); // eslint-disable-line no-console
        return EXIT.OK;
      } catch (err) {
        auditLog?.({ actor: cliActor(), action: 'cli.tasks.run', entity: 'task', entityId: name, meta: { ms: Date.now() - started }, result: 'failure' });
        console.error(`Task "${name}" failed: ${err?.message ?? err}`); // eslint-disable-line no-console
        return EXIT.FAILURE;
      }
    },
  });
}
