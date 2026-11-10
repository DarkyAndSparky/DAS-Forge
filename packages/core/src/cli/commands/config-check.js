import { flattenConfig } from '../../admin/sections-system.js';
import { describeSources, schemaDefaults } from '../../config/sources.js';

/**
 * `app config check` - loads and validates app.config.js without
 * starting the app, so a bad config is caught at deploy time (or by a
 * pre-flight CI step) rather than as a crash on boot.
 *
 * @param {object} cli - from createCli()
 * @param {object} opts
 * @param {(opts: object) => Promise<object>} opts.loadConfigFn - core/config's loadConfig
 * @param {string} [opts.cwd]
 */
export function registerConfigCheckCommand(cli, { loadConfigFn, cwd }) {
  cli.command('config check', {
    description: 'Validate app.config.js without starting the app',
    async handler({ flags }) {
      try {
        const config = await loadConfigFn({ cwd: flags.cwd ?? cwd });
        // eslint-disable-next-line no-console
        console.log(`Configuration valid (appName="${config.appName}", env="${config.env}")`);
        return 0;
      } catch (err) {
        if (err.error === 'VALIDATION_ERROR') {
          // eslint-disable-next-line no-console
          console.error('Configuration invalid:\n');
          for (const field of err.fields) {
            // eslint-disable-next-line no-console
            console.error(`  - ${field.path || '(root)'}: ${field.message}`);
          }
          return 1;
        }
        throw err;
      }
    },
  });

  cli.command('config show', {
    description: 'Show the effective configuration with the source of each value (app config show [--changed] [--json] [text])',
    async handler({ flags, positionals }) {
      const report = {};
      let config;
      try {
        config = await loadConfigFn({ cwd: flags.cwd ?? cwd, report });
      } catch (err) {
        if (err.error === 'VALIDATION_ERROR') { console.error('Configuration invalid; run "config check" for the details.'); return 1; } // eslint-disable-line no-console
        throw err;
      }
      const q = (positionals[0] ?? '').toLowerCase();
      let rows = describeSources(flattenConfig(config), { fileConfig: report.fileConfig, envPaths: report.envPaths, defaults: schemaDefaults() });
      if (q) rows = rows.filter((r) => r.path.toLowerCase().includes(q));
      if (flags.changed) rows = rows.filter((r) => r.source !== 'default' && r.changed !== false);
      if (flags.json) { console.log(JSON.stringify(rows.map((r) => ({ ...r, value: r.value === null ? '(hidden)' : r.value })))); return 0; } // eslint-disable-line no-console
      for (const r of rows) {
        const v = r.value === null ? '(hidden)' : typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
        console.log(`${r.path.padEnd(44)} ${r.source.padEnd(8)} ${v}${r.changed ? '   (differs from default)' : ''}`); // eslint-disable-line no-console
      }
      if (rows.length === 0) console.log('Nothing matches.'); // eslint-disable-line no-console
      return 0;
    },
  });
}
