import { flagString } from '../arg-parser.js';
import { EXIT } from '../exit-codes.js';
import { parseDuration } from '../../security/bans.js';

/**
 * `app ban add <ip|user> <value> [--reason text] [--duration 2h]`, `app ban lift <ip|user> <value>`,
 * `app ban list [--all] [--json]`. A running server picks changes up within a few seconds.
 * @param {object} opts.bans - createBans() instance
 */
export function registerBanCommands(cli, { bans }) {
  const usage = (s) => { console.error(`Usage: ${s}`); return EXIT.USAGE; }; // eslint-disable-line no-console

  cli.command('ban add', {
    description: 'Ban an IP address or a username (app ban add <ip|user> <value> [--reason text] [--duration 2h])',
    handler({ positionals, flags }) {
      const [kind, value] = positionals;
      if (!kind || !value) return usage('ban add <ip|user> <value> [--reason text] [--duration 30m|2h|7d]');
      try {
        const r = bans.ban({ kind, value, reason: flagString(flags, 'reason') ?? null, by: 'cli', durationMs: parseDuration(flagString(flags, 'duration')) });
        // eslint-disable-next-line no-console
        console.log(r.already ? `Already banned: ${r.kind} ${r.value} (#${r.id}).` : `Banned ${r.kind} ${r.value} (#${r.id})${r.expiresAt ? ` until ${r.expiresAt}` : ' permanently'}${r.sessionsEnded ? `; ${r.sessionsEnded} session(s) ended` : ''}.`);
        return 0;
      } catch (err) {
        console.error(err.message); // eslint-disable-line no-console
        return EXIT.USAGE;
      }
    },
  });

  cli.command('ban lift', {
    description: 'Lift a ban (app ban lift <ip|user> <value>)',
    handler({ positionals }) {
      const [kind, value] = positionals;
      if (!kind || !value) return usage('ban lift <ip|user> <value>');
      try {
        const n = bans.lift({ kind, value, by: 'cli' });
        console.log(n ? `Lifted ${n} ban(s) for ${kind} ${value}.` : `No active ban for ${kind} ${value}.`); // eslint-disable-line no-console
        return 0;
      } catch (err) {
        console.error(err.message); // eslint-disable-line no-console
        return EXIT.USAGE;
      }
    },
  });

  cli.command('ban list', {
    description: 'List bans (app ban list [--all] [--json])',
    handler({ flags }) {
      const rows = bans.list({ active: flags.all !== true });
      if (flags.json) { console.log(JSON.stringify(rows)); return 0; } // eslint-disable-line no-console
      if (!rows.length) { console.log('No bans.'); return 0; } // eslint-disable-line no-console
      for (const r of rows) {
        // eslint-disable-next-line no-console
        console.log(`  #${r.id}  ${r.kind.padEnd(4)} ${r.value}  ${r.expiresAt ? `until ${r.expiresAt}` : 'permanent'}${r.liftedAt ? '  (lifted)' : ''}${r.reason ? `  - ${r.reason}` : ''}`);
      }
      return 0;
    },
  });
}
