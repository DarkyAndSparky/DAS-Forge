/**
 * A tiny stand-in for what a real optional package (a future
 * @das-forge/ldap, or an app's own "reporting" feature area) looks
 * like from core's point of view: a plain object matching
 * ModuleRegistrationSchema, handed to the module registry in
 * context.js. Nothing in core/http or core/cli imports this file -
 * they only ever see what the registry exposes after registration.
 *
 * This REPLACES the old hand-rolled `ASSET_FIELD_PERMISSIONS = { cost:
 * 'read:finance' }` constant that used to live directly in routes.js -
 * that was routes.js (i.e. "core-adjacent" wiring code) knowing an
 * app-specific fact (asset cost is finance-gated). Now routes.js asks
 * the registry for the merged field-permission map instead, and has no
 * opinion of its own about what "cost" or "finance" even mean - exactly
 * §1's principle: the wiring code operates on the Module contract, not
 * on domain knowledge.
 *
 * Exported as a FACTORY (createReportingModule), not a static object,
 * because its `dataSubject.export` (core/privacy, §4.5k) needs a real
 * `db` to look something up - a module is ordinary app code, free to
 * import core/auth/core/audit itself when that's genuinely what it
 * needs, same as context.js does.
 */
export function createReportingModule({ db, findUserByIdFn, auditQueryFn }) {
  return {
    id: 'reporting',
    permissions: ['read:finance'],
    fieldPermissions: {
      // The ASSETS stand-in's `cost` field (routes.js) is gated behind
      // this permission - previously hardcoded in routes.js itself.
      cost: 'read:finance',
    },
    // core/ui's AppShell (§5.4) consumes this: a nav entry gated behind
    // the SAME permission that gates the `cost` field above, so a
    // viewer without read:finance never even sees a link to a page
    // about finances, on top of never seeing the field itself.
    navigation: [{ id: 'reporting-home', label: 'reporting.nav.home', path: '/ui/reporting', permission: 'read:finance' }],
    translations: { ru: { 'reporting.nav.home': 'Отчёты' }, en: { 'reporting.nav.home': 'Reports' } },
    // core/ui's searchModules() consumes this: a real (if tiny) search
    // over this module's own domain - matches audit actions by
    // substring, not a fabricated result set.
    search: {
      label: 'Reports',
      provider: async (query) => {
        const needle = String(query ?? '').toLowerCase();
        return auditQueryFn(db, { limit: 1000 })
          .filter((entry) => entry.action.toLowerCase().includes(needle))
          .map((entry) => ({ action: entry.action, actor: entry.actor, createdAt: entry.createdAt }));
      },
    },
    cliCommands: [
      {
        name: 'report summary',
        description: 'Print a demo report summary (module: reporting)',
        handler({ flags }) {
          const summary = { generatedAt: new Date().toISOString(), note: 'demo module command, no real data source' };
          // eslint-disable-next-line no-console
          console.log(flags.json ? JSON.stringify(summary) : `Report summary generated at ${summary.generatedAt}`);
          return 0;
        },
      },
    ],
    // core/privacy's data-subject contract (§4.5k): this module doesn't
    // own a table of its own in this demo, so it reports something
    // genuinely true instead of fabricating owned data - how many
    // audit-logged actions this user has performed, read from the
    // already-real core/audit log. erase() has nothing of its own to
    // remove (no owned table), so it's an honest no-op, not a stub
    // pretending to delete something that doesn't exist.
    dataSubject: {
      export: async (userId) => {
        const user = findUserByIdFn(db, userId);
        if (!user) return { actionsPerformed: 0 };
        return { actionsPerformed: auditQueryFn(db, { actor: user.username, limit: 100000 }).length };
      },
      erase: async () => {
        // nothing owned by this demo module to erase
      },
    },
  };
}
