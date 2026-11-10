/**
 * §5.4's "Глобальный поиск" surface: calls every registered module's
 * `search.provider(query)` (core/modules' ModuleRegistrationSchema) and
 * merges the results, tagged by which module and under which label they
 * came from. core/ui never knows what any individual module's results
 * look like internally - a module's provider returns whatever shape it
 * wants, this just groups the groups.
 *
 * One provider throwing doesn't break search for the others - same
 * "one module's failure doesn't hide the rest" rule core/privacy's
 * exportUserData/eraseUserData already apply.
 *
 * @param {{getSearchProviders: () => Array}} moduleRegistry
 * @param {string} query
 * @returns {Promise<Array<{moduleId: string, label: string, results: unknown[]}|{moduleId: string, label: string, error: string}>>}
 */
export async function searchModules(moduleRegistry, query) {
  const providers = moduleRegistry.getSearchProviders();

  return Promise.all(
    providers.map(async ({ moduleId, label, provider }) => {
      try {
        const results = await provider(query);
        return { moduleId, label, results };
      } catch (err) {
        return { moduleId, label, error: err.message };
      }
    })
  );
}
