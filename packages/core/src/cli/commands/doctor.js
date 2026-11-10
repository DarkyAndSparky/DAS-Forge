import { runDoctor } from '../../health/doctor.js';
import { formatDoctorText, formatDoctorJson } from '../../health/format.js';
import { localizeDoctor } from '../../health/localize.js';

/**
 * `app doctor [--json] [--fix] [--lang ru|en]` - full environment/installation
 * diagnosis. This command is a thin CLI wrapper; `categoryProviders`
 * (the actual checks - Runtime/Database/Storage/Security/Application,
 * extended with Integrations etc. as those modules land) is supplied
 * by the app, same pattern as `registerBackupCommands` taking an
 * already-built `runBackupFn` rather than constructing one itself.
 *
 * @param {object} cli
 * @param {object} opts
 * @param {import('../../health/doctor.js').CategoryProvider[]} opts.categoryProviders
 * @param {string} [opts.title]
 */
export function registerDoctorCommand(cli, { categoryProviders, title = 'Doctor' }) {
  cli.command('doctor', {
    description: 'Full environment/installation diagnostics',
    async handler({ flags }) {
      const result = await runDoctor(categoryProviders, { fix: Boolean(flags.fix) });

      // Text output follows --lang (default: the system language); JSON stays English and machine-readable.
      const sys = String(process.env.LC_ALL || process.env.LANGUAGE || process.env.LANG || '').toLowerCase();
      const lang = flags.lang === 'ru' || flags.lang === 'en' ? flags.lang : sys.startsWith('ru') ? 'ru' : 'en';
      // eslint-disable-next-line no-console
      console.log(flags.json ? formatDoctorJson(result) : formatDoctorText(localizeDoctor(result, lang), { title: lang === 'ru' && title === 'Doctor' ? 'Диагностика' : title, lang }));

      return result.exitCode;
    },
  });
}
