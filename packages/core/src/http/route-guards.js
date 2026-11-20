/**
 * Marks a middleware as an access guard, so `findUnguardedRoutes` can tell a route that checks access from one that forgot to.
 * The mark is a property on the function; the function itself works exactly as before.
 */
export const GUARD = Symbol.for('das-forge.guard');

/** @template {Function} F @param {F} fn @param {string} kind e.g. 'auth', 'permission', 'object' @returns {F} */
export function markGuard(fn, kind) {
  Object.defineProperty(fn, GUARD, { value: kind, enumerable: false });
  return fn;
}

export const isGuard = (fn) => typeof fn === 'function' && typeof fn[GUARD] === 'string';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/**
 * Lists the routes of an Express app (or router) that have no guard in their handler chain, so a forgotten `requirePermission`
 * shows up in a test instead of in production. A guard is anything made by `requireAuth`, `requirePermission`,
 * `requireObjectAccess` or marked with `markGuard`; a router-level `router.use(guard)` counts for the routes after it.
 *
 * `allow` lists routes that are public on purpose, as `'GET /health'` strings or `RegExp`s tested against that string.
 * Nested routers are followed; their mount path is shown when it can be recovered, otherwise as `(mounted)`.
 * @param {object} appOrRouter an Express 5 app (`app.router`) or router (`router.stack`)
 * @returns {{method:string, path:string}[]}
 */
export function findUnguardedRoutes(appOrRouter, { allow = [] } = {}) {
  const root = appOrRouter?.router ?? appOrRouter;
  const stack = root?.stack;
  if (!Array.isArray(stack)) throw new TypeError('findUnguardedRoutes: expected an Express app or router');
  const out = [];
  const allowed = (label) => allow.some((a) => (a instanceof RegExp ? a.test(label) : a === label));
  const walk = (layers, prefix, guarded) => {
    let g = guarded;
    for (const layer of layers) {
      if (layer.route) {
        const route = layer.route;
        const chain = route.stack ?? [];
        const routeGuarded = g || chain.some((l) => isGuard(l.handle));
        const methods = METHODS.filter((m) => route.methods?.[m] || chain.some((l) => l.method === m));
        const path = prefix + (Array.isArray(route.path) ? route.path.join('|') : String(route.path));
        if (!routeGuarded) {
          for (const method of methods.length ? methods : ['all']) {
            const label = `${method.toUpperCase()} ${path}`;
            if (!allowed(label)) out.push({ method: method.toUpperCase(), path });
          }
        }
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        const mount = layer.path ?? layer.pathPrefix ?? '(mounted)';
        walk(layer.handle.stack, prefix + (mount === '/' ? '' : mount), g);
      } else if (isGuard(layer.handle)) {
        g = true;
      }
    }
  };
  walk(stack, '', false);
  return out;
}
