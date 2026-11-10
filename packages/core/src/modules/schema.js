import { z } from 'zod';

/**
 * §1's principle in code: "core doesn't need to know what Atlas,
 * procure-it etc. are - it operates only through contracts
 * (ApplicationConfig, Module, DatabaseAdapter, ...)". ApplicationConfig
 * is core/config; DatabaseAdapter is core/database/adapter.js; this
 * schema (plus registry.js's createModuleRegistry()) is the third -
 * what a module (an optional package, or an app's own feature area)
 * hands core at startup, and the only way core ever learns about it.
 *
 * This is the FULL §7.5 ModuleRegistrationSchema shape - every field a
 * module can register is accepted and stored here. What differs by
 * field is what core currently DOES with it after storing it:
 *
 *   - `permissions`, `fieldPermissions`, `cliCommands` are consumed
 *     TODAY: core/http's serialize() takes a fieldPermissions map
 *     (previously hand-rolled per app, see examples/workshop's old
 *     ASSET_FIELD_PERMISSIONS constant), core/cli's createCli() has a
 *     command(path, {handler}) call to hang cliCommands on.
 *   - `navigation`, `routes`, `translations`, `search` are
 *     @das-forge/ui's registration surface (§5.4 UI Module Contract).
 *     `dataSubject` (export/erase/retentionDays/legalBasis/purpose) is
 *     core/privacy's registration surface (§4.5k). Neither
 *     @das-forge/ui nor core/privacy exists yet, so these are validated
 *     and stored by registry.js (getNavigation()/getRoutes()/
 *     getTranslations()/getSearchProviders()/getDataSubjectHandlers()),
 *     but nothing in core reads them back out and acts on them yet -
 *     there is no UI shell to feed `navigation`/`routes`/`translations`
 *     into, no search index to register `search.provider` with, no
 *     privacy export/erase job runner to call `dataSubject.export`/
 *     `erase`. A module registering these today isn't getting a
 *     facade that pretends to work - it's getting accurate storage of
 *     data that core doesn't lose, ready to be wired up the moment
 *     @das-forge/ui / core/privacy land (tracked in roadmap.md §11c).
 *
 * `z.function()` isn't used for any function-valued field (`cliCommands[].handler`,
 * `search.provider`, `dataSubject.export`/`erase`) - Zod 4 redesigned
 * z.function() into a standalone function-factory that can no longer
 * sit inside z.object() as a field schema (API restructure, v4
 * changelog). A plain runtime typeof-check via z.custom() is the
 * correct v4-compatible replacement, and is no weaker than the
 * roadmap's own z.function() ever was - the doc itself says that check
 * was deliberately shallow ("this is a function", not a signature
 * check); real correctness is the module's own unit tests, same as
 * before.
 */
const FunctionSchema = z.custom((val) => typeof val === 'function', { message: 'must be a function' });

const NavigationItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1), // i18n key, not a literal display string
  path: z.string().min(1),
  icon: z.string().optional(),
  permission: z.string().optional(),
});

export const ModuleRegistrationSchema = z.object({
  id: z.string().min(1),

  // --- consumed today ---------------------------------------------
  // Permissions this module introduces to the app's permission set
  // (e.g. 'read:finance') - purely declarative bookkeeping today
  // (surfaced via getPermissions()); core/auth's RBAC doesn't currently
  // consume this list to validate role definitions against it, that's
  // a reasonable next step once more than one real module exists to
  // prove the need.
  permissions: z.array(z.string()).default([]),
  // fieldName -> required permission, merged into a single registry-wide
  // map (registry.js) that route handlers pass straight into
  // core/http's serialize().
  fieldPermissions: z.record(z.string(), z.string()).default({}),
  cliCommands: z
    .array(
      z.object({
        // Space-separated command path, same convention as core/cli's
        // own commands, e.g. 'report summary'.
        name: z.string().min(1),
        description: z.string().default(''),
        handler: FunctionSchema,
      })
    )
    .default([]),

  // --- stored, not yet consumed (waiting on @das-forge/ui) ---------
  navigation: z.array(NavigationItemSchema).default([]),
  routes: z.array(z.object({ path: z.string().min(1), component: z.string().min(1) })).default([]),
  // NOT z.record(z.enum(['ru','en']), ...) - in Zod 4, z.record() keyed
  // by an enum/union produces an EXACT mapped type requiring every
  // member of the union as a key (confirmed by the real test failure
  // this fixes: registering `translations: { ru: {...} }` alone threw
  // "translations.en: expected record, received undefined"). A plain
  // object with each locale optional is the correct shape for "ru
  // and/or en, either or both".
  translations: z
    .object({
      ru: z.record(z.string(), z.string()).optional(),
      en: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  search: z.object({ provider: FunctionSchema, label: z.string().min(1) }).optional(),

  // --- stored, not yet consumed (waiting on core/privacy) ----------
  dataSubject: z
    .object({
      export: FunctionSchema,
      erase: FunctionSchema,
      retentionDays: z.number().int().positive().optional(), // undefined = indefinite retention
      legalBasis: z.string().optional(),
      purpose: z.string().optional(),
    })
    .optional(),
});
