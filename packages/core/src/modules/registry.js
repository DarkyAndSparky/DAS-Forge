import { ModuleRegistrationSchema } from './schema.js';

/**
 * Collects ModuleRegistrationSchema-shaped registrations from however
 * many modules an app wires up, and exposes the merged result - for
 * core/http (fieldPermissions) and core/cli (cliCommands) to consume
 * TODAY, and for a future @das-forge/ui (navigation/routes/translations/
 * search) and core/privacy (dataSubject) to consume once they exist -
 * without core/http or core/cli ever importing a module directly. The
 * app (examples/workshop/src/context.js, eventually a real ported app)
 * is the only place that imports both core and its chosen modules; core
 * itself stays exactly as ignorant of "what a reporting module is" as
 * §1 requires.
 *
 * navigation/routes/translations/search/dataSubject are validated and
 * stored here (nothing a module registers is silently dropped), but
 * nothing in core reads them back out yet - see schema.js's module doc
 * comment for exactly why, and roadmap.md §11c for the tracking note on
 * wiring them up once @das-forge/ui / core/privacy exist.
 */
export function createModuleRegistry() {
  const modules = new Map();
  const fieldPermissions = {};
  const permissions = new Set();
  const cliCommands = [];
  const navigation = [];
  const routes = [];
  const translations = { ru: {}, en: {} };
  const searchProviders = [];
  const dataSubjectHandlers = [];

  function registerModule(registration) {
    const parsed = ModuleRegistrationSchema.parse(registration);

    if (modules.has(parsed.id)) {
      throw new Error(`Module "${parsed.id}" is already registered`);
    }

    // A field permission conflict between two independently-written
    // modules is a real bug worth surfacing loudly at startup (same
    // "fail fast at boot, not deep in a 2am TypeError" philosophy as
    // assertDatabaseAdapter/assertAuthProvider) - NOT something to
    // silently resolve by last-registered-wins, which would quietly
    // loosen or tighten access depending on registration order.
    for (const [field, permission] of Object.entries(parsed.fieldPermissions)) {
      if (fieldPermissions[field] !== undefined && fieldPermissions[field] !== permission) {
        throw new Error(
          `Field permission conflict on "${field}": module "${parsed.id}" wants "${permission}", ` +
            `already registered as "${fieldPermissions[field]}" by another module`
        );
      }
      fieldPermissions[field] = permission;
    }

    for (const p of parsed.permissions) permissions.add(p);
    for (const cmd of parsed.cliCommands) cliCommands.push({ ...cmd, moduleId: parsed.id });

    for (const item of parsed.navigation) navigation.push({ ...item, moduleId: parsed.id });
    for (const route of parsed.routes) routes.push({ ...route, moduleId: parsed.id });

    if (parsed.translations) {
      for (const locale of ['ru', 'en']) {
        const keys = parsed.translations[locale];
        if (!keys) continue;
        for (const [key, value] of Object.entries(keys)) {
          // Same "fail at registration, don't silently overwrite"
          // stance as fieldPermissions - two modules translating the
          // same key differently is a real naming collision to catch
          // at boot, not resolve by registration order.
          if (translations[locale][key] !== undefined && translations[locale][key] !== value) {
            throw new Error(
              `Translation conflict on "${locale}.${key}": module "${parsed.id}" wants "${value}", ` +
                `already registered as "${translations[locale][key]}" by another module`
            );
          }
          translations[locale][key] = value;
        }
      }
    }

    if (parsed.search) searchProviders.push({ ...parsed.search, moduleId: parsed.id });
    if (parsed.dataSubject) dataSubjectHandlers.push({ ...parsed.dataSubject, moduleId: parsed.id });

    modules.set(parsed.id, parsed);
    return parsed;
  }

  return {
    registerModule,
    getModule: (id) => modules.get(id),
    listModuleIds: () => [...modules.keys()],

    /** Merged fieldName -> permission map, ready to pass into core/http's serialize(). */
    getFieldPermissions: () => ({ ...fieldPermissions }),
    getPermissions: () => [...permissions],
    getCliCommands: () => cliCommands.map((c) => ({ ...c })),
    /**
     * Registers every module's cliCommands onto a core/cli `createCli()`
     * instance. This is the one place a module's commands actually meet
     * the CLI - core/cli's own commands/*.js files never reference a
     * module, and a module never touches `cli` directly either.
     */
    applyCliCommands(cli) {
      for (const { name, description, handler, moduleId } of cliCommands) {
        cli.command(name, {
          description: description || `(module: ${moduleId})`,
          handler,
        });
      }
    },

    // --- stored for @das-forge/ui, not yet consumed by anything -----
    /** Every registered navigation item, across all modules, tagged with its moduleId. */
    getNavigation: () => navigation.map((n) => ({ ...n })),
    /** Every registered route, across all modules, tagged with its moduleId. */
    getRoutes: () => routes.map((r) => ({ ...r })),
    /** Merged { ru: {key: value}, en: {key: value} } translation maps. */
    getTranslations: () => ({ ru: { ...translations.ru }, en: { ...translations.en } }),
    /** Every registered search provider, across all modules, tagged with its moduleId. */
    getSearchProviders: () => searchProviders.map((s) => ({ ...s })),

    // --- stored for core/privacy, not yet consumed by anything ------
    /** Every registered data-subject export/erase handler, tagged with its moduleId. */
    getDataSubjectHandlers: () => dataSubjectHandlers.map((d) => ({ ...d })),
  };
}
