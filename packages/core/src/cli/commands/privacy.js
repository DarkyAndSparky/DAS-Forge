import { flagString } from '../arg-parser.js';
import { writeOwnerOnly } from '../safe-write.js';
import { EXIT } from '../exit-codes.js';
import { cliActor } from '../actor.js';

/**
 * `app privacy {export, erase}` - §4.5k's CLI surface. The doc's own
 * example uses `--user <email>`; this uses `--user <username>` instead,
 * for the same reason `user reset-password` (cli/commands/user-admin.js)
 * does - email is nullable in UserSchema (not every user has one), but
 * username is the one identifier core/auth guarantees is always present
 * and unique.
 *
 * `erase --mode delete` requires BOTH `--mode delete` AND `--yes` -
 * `anonymize` only needs `--yes`. This mirrors §4.5g/§4.5k's "то же
 * двойное подтверждение, что и у Secrets rotation" for the admin-panel
 * path; the CLI's equivalent of "double" confirmation is: the
 * destructive mode must be named explicitly AND the destructive intent
 * flag must be passed, rather than one flag doing both jobs.
 *
 * @param {object} cli
 * @param {object} opts
 * @param {(username: string) => {id:number}|null} opts.findUserByUsernameFn - core/auth's findUserByUsername
 * @param {(opts:object) => Promise<object>} opts.exportUserDataFn - core/privacy's exportUserData, pre-bound to db/registry
 * @param {(opts:object) => Promise<object>} opts.eraseUserDataFn - core/privacy's eraseUserData, pre-bound to db/registry
 * @param {() => {entries: object[], gaps: string[]}} [opts.registryFn] - `privacy.buildProcessingRegistry` bound to the app; enables `privacy registry`
 * @param {(registry: object, o: {format: string, lang: string}) => string} [opts.formatRegistryFn] - `privacy.formatProcessingRegistry`
 * @param {object} [opts.incidents] - `privacy.createIncidentRegister()` result; enables `privacy incident declare|list|show|update`
 * @param {() => Promise<{checked:number, reapplied:number[], skipped:number}>} [opts.reapplyErasuresFn] - enables `privacy reapply-erasures` (audit F08)
 */
export function registerPrivacyCommands(cli, { findUserByUsernameFn, exportUserDataFn, eraseUserDataFn, reapplyErasuresFn, incidents, registryFn, formatRegistryFn }) {
  if (incidents) registerIncidentCommands(cli, incidents);
  if (registryFn) {
    cli.command('privacy registry', {
      description: 'Register of personal-data processing (app privacy registry [--format md|csv|json] [--lang ru|en] [--out <file>])',
      async handler({ flags }) {
        const format = flagString(flags, 'format') ?? 'md';
        const lang = flagString(flags, 'lang') ?? 'ru';
        if (!['md', 'csv', 'json'].includes(format) || !['ru', 'en'].includes(lang)) {
          // eslint-disable-next-line no-console
          console.error('Usage: privacy registry [--format md|csv|json] [--lang ru|en] [--out <file>]');
          return EXIT.USAGE;
        }
        const registry = registryFn();
        const text = formatRegistryFn(registry, { format, lang });
        const out = flagString(flags, 'out');
        if (out) {
          writeOwnerOnly(out, text, { force: flags.force === true });
          // eslint-disable-next-line no-console
          console.log(`Register written to ${out} (${registry.entries.length} lines).`);
        } else {
          // eslint-disable-next-line no-console
          console.log(text);
        }
        if (registry.gaps.length) {
          // eslint-disable-next-line no-console
          console.error(`Warning: no purpose or legal basis declared by: ${registry.gaps.join(', ')} (set dataSubject.purpose and dataSubject.legalBasis in the module).`);
        }
        return 0;
      },
    });
  }
  if (reapplyErasuresFn) {
    cli.command('privacy reapply-erasures', {
      description: 'Erase again the people erased before a backup restore (app privacy reapply-erasures)',
      async handler() {
        const r = await reapplyErasuresFn();
        // eslint-disable-next-line no-console
        console.log(`Erasure ledger: ${r.checked} entr${r.checked === 1 ? 'y' : 'ies'}, re-applied ${r.reapplied.length}, already clean/unmatched ${r.skipped}.`);
        return 0;
      },
    });
  }

  cli.command('privacy export', {
    description: "Export a user's data across all modules (app privacy export --user <username> [--out <file>])",
    async handler({ flags }) {
      const username = flagString(flags, 'user');
      const out = flagString(flags, 'out');
      if (!username) {
        // eslint-disable-next-line no-console
        console.error('Usage: privacy export --user <username> [--out <file>] [--force]');
        return EXIT.USAGE;
      }

      const user = findUserByUsernameFn(username);
      if (!user) {
        // eslint-disable-next-line no-console
        console.error(`No such user: "${username}"`);
        return 1;
      }

      const result = await exportUserDataFn({ userId: user.id, actor: cliActor() });
      const json = JSON.stringify(result, null, 2);

      if (out) {
        writeOwnerOnly(out, json, { force: flags.force === true });
        // eslint-disable-next-line no-console
        console.log(`Exported data for "${username}" to ${out} (owner-only file; it holds personal data - store it safely).`);
      } else {
        // eslint-disable-next-line no-console
        console.log(json);
      }
      return 0;
    },
  });

  cli.command('privacy erase', {
    description:
      'Erase (anonymize by default) a user and their data across all modules ' +
      '(app privacy erase --user <username> [--mode anonymize|delete] --yes)',
    async handler({ flags }) {
      const username = flagString(flags, 'user');
      if (!username) {
        // eslint-disable-next-line no-console
        console.error('Usage: privacy erase --user <username> [--mode anonymize|delete] --yes');
        return EXIT.USAGE;
      }

      const mode = flags.mode === 'delete' ? 'delete' : 'anonymize';
      if (flags.mode && flags.mode !== 'anonymize' && flags.mode !== 'delete') {
        // eslint-disable-next-line no-console
        console.error(`--mode must be "anonymize" or "delete", got: "${flags.mode}"`);
        return EXIT.USAGE;
      }

      if (flags.yes !== true) {
        // eslint-disable-next-line no-console
        console.error(
          mode === 'delete'
            ? `This will PERMANENTLY DELETE "${username}" and all account data. Re-run with --yes to proceed.`
            : `This will anonymize "${username}" (identifying fields replaced, login disabled; audit history is preserved as-is). Re-run with --yes to proceed.`
        );
        return 1;
      }

      const user = findUserByUsernameFn(username);
      if (!user) {
        // eslint-disable-next-line no-console
        console.error(`No such user: "${username}"`);
        return 1;
      }

      const result = await eraseUserDataFn({ userId: user.id, mode, actor: cliActor() });

      // eslint-disable-next-line no-console
      console.log(`${result.accountErased ? '✓' : '✗'} account ${mode === 'delete' ? 'deleted' : 'anonymized'}: "${username}"`);
      for (const [moduleId, status] of Object.entries(result.moduleResults)) {
        // eslint-disable-next-line no-console
        console.log(`  ${status === 'ok' ? '✓' : '✗'} ${moduleId}: ${status}`);
      }

      return result.accountErased ? 0 : 1;
    },
  });
}

function registerIncidentCommands(cli, incidents) {
  const out = (m) => console.log(m); // eslint-disable-line no-console
  const err = (m) => console.error(m); // eslint-disable-line no-console
  const line = (i) => `#${i.id} [${i.status}] ${i.severity}${i.personalData ? ' PD' : ''} ${i.detectedAt.slice(0, 16)}Z ${i.title}${i.firstNoticeDue?.overdue || i.detailsDue?.overdue ? '  !! OVERDUE' : ''}`;
  const fail = (e) => { if (e?.name === 'IncidentError') { err(`Incident error: ${e.code}`); return 1; } throw e; };
  const id = (flags) => flagString(flags, 'id');

  cli.command('privacy incident declare', {
    description: 'Record a security incident (app privacy incident declare --title <text> [--description <text>] [--severity low|medium|high] [--personal-data] [--detected <ISO date>])',
    async handler({ flags }) {
      const title = flagString(flags, 'title');
      if (!title) { err('Usage: privacy incident declare --title <text> [--description <text>] [--severity low|medium|high] [--personal-data] [--detected <ISO date>]'); return EXIT.USAGE; }
      try {
        const i = incidents.declare({ title, description: flagString(flags, 'description') ?? '', severity: flagString(flags, 'severity') ?? 'medium', personalData: flags['personal-data'] === true, detectedAt: flagString(flags, 'detected'), actor: cliActor() });
        out(`Recorded incident #${i.id}.`);
        if (i.firstNoticeDue) out(`Personal data involved: first notice due ${i.firstNoticeDue.at}, details due ${i.detailsDue.at} (check the current deadlines with a lawyer).`);
        return 0;
      } catch (e) { return fail(e); }
    },
  });

  cli.command('privacy incident list', {
    description: 'List security incidents (app privacy incident list [--status open|notified|closed])',
    async handler({ flags }) {
      const rows = incidents.list({ status: flagString(flags, 'status') });
      if (!rows.length) out('No incidents.');
      for (const i of rows) out(line(i));
      return 0;
    },
  });

  cli.command('privacy incident show', {
    description: 'Show one incident (app privacy incident show --id <n>)',
    async handler({ flags }) {
      const i = incidents.get(id(flags));
      if (!i) { err('No such incident.'); return 1; }
      out(JSON.stringify(i, null, 2));
      return 0;
    },
  });

  cli.command('privacy incident update', {
    description: 'Record progress (app privacy incident update --id <n> [--status open|notified|closed] [--severity ...] [--first-notice <ISO date>] [--details-notice <ISO date>] [--measures <text>])',
    async handler({ flags }) {
      const n = id(flags);
      if (!n) { err('Usage: privacy incident update --id <n> [--status ...] [--severity ...] [--first-notice <date>] [--details-notice <date>] [--measures <text>]'); return EXIT.USAGE; }
      try {
        incidents.update(n, { status: flagString(flags, 'status'), severity: flagString(flags, 'severity'), firstNoticeAt: flagString(flags, 'first-notice'), detailsNoticeAt: flagString(flags, 'details-notice'), measures: flagString(flags, 'measures'), actor: cliActor() });
        out(`Updated incident #${n}.`);
        return 0;
      } catch (e) { return fail(e); }
    },
  });
}
