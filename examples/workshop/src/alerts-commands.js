/**
 * `app alerts test` and `app alerts list`: a way to see the alerts module work without breaking anything.
 *
 *   node bin/app.js alerts test --severity critical    # a real alert: table row, log line, mail to the contacts
 *   node bin/app.js alerts list                        # the newest alerts
 *
 * `test` goes through the same `buildAlerts` the server uses, so what it proves is what the server does:
 * the row appears in the admin section "Alerts", and with e-mail configured the mail is put into the queue
 * (the running server's queue loop delivers it; without a running server it waits in the queue).
 * The in-memory cooldown belongs to one process, so every CLI call raises a fresh alert.
 */
import { alerts as alertsModule } from '@das-forge/core';
import { buildAlerts } from './context.js';

const out = (line) => console.log(line); // eslint-disable-line no-console
const err = (line) => console.error(line); // eslint-disable-line no-console

export function registerAlertsCommands(cli, { ctx, getDb }) {
  cli.command('alerts test', {
    description: 'Raise a test alert: stored, logged and mailed to security.incidentContacts',
    usage: '[--severity info|warning|critical] [--key name] [--message text]',
    flags: [
      { name: '--severity', description: 'importance, default warning' },
      { name: '--key', description: 'alert key, default cli:test (the same key inside the cooldown is not mailed twice)' },
      { name: '--message', description: 'text of the alert' },
    ],
    examples: ['alerts test', 'alerts test --severity critical --message "disk is full"'],
    handler({ flags }) {
      return run();
      async function run() {
        const severity = typeof flags.severity === 'string' ? flags.severity : 'warning';
        if (!alertsModule.SEVERITIES.includes(severity)) {
          err(`Unknown severity "${severity}". Use one of: ${alertsModule.SEVERITIES.join(', ')}.`);
          return 2;
        }
        const set = buildAlerts({ ...ctx, db: getDb() }, { warn: () => {}, error: () => {} });
        if (!set) {
          err('Alerts are switched off (alerts.enabled = false in the configuration).');
          return 1;
        }
        const key = typeof flags.key === 'string' && flags.key ? flags.key : 'cli:test';
        const message = typeof flags.message === 'string' && flags.message ? flags.message : 'A test alert raised from the command line.';
        const r = await set.alerts.raise({ key, severity, title: 'Test alert', message });
        if (!r.raised) {
          err('The alert could not be recorded; see the log.');
          return 1;
        }
        const row = set.alerts.list({ limit: 1 }).find((a) => a.id === r.id);
        out(`Alert #${r.id} recorded (${severity}, key "${key}").`);
        if (!set.mailConfigured) out('No mail: e-mail is off or security.incidentContacts is empty. The alert is visible in the admin section "Alerts".');
        else if (row?.notified) out('Mail queued for security.incidentContacts; the running server delivers it.');
        else out(`Mail was NOT queued${row?.notifyError ? ` (${row.notifyError})` : ''}.`);
        return 0;
      }
    },
  });

  cli.command('alerts list', {
    description: 'Show the newest alerts',
    usage: '[--limit n] [--json]',
    flags: [{ name: '--limit', description: 'how many, default 20' }],
    examples: ['alerts list --limit 5'],
    handler({ flags }) {
      const set = buildAlerts({ ...ctx, db: getDb() }, null);
      if (!set) {
        err('Alerts are switched off (alerts.enabled = false in the configuration).');
        return 1;
      }
      const limit = Number.isInteger(Number(flags.limit)) && Number(flags.limit) > 0 ? Number(flags.limit) : 20;
      const rows = set.alerts.list({ limit });
      if (flags.json) { out(JSON.stringify(rows)); return 0; }
      if (!rows.length) { out('No alerts.'); return 0; }
      for (const a of rows) out(`  #${a.id}  ${a.lastAt}  ${a.severity.padEnd(8)}  x${a.repeats + 1}  ${a.notified ? 'mailed' : 'no mail'}  ${a.title}: ${a.message}`);
      return 0;
    },
  });
}
