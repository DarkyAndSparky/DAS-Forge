/**
 * Lets code written with `await` use an object that is synchronous, asynchronous, or both.
 *
 * `asyncView(obj)` returns an object whose methods call `obj.<name>Async` when there is one and `obj.<name>` otherwise.
 * The caller always writes `await view.name(...)`: it works the same for a synchronous object (the value is returned at once)
 * and for one that talks to an asynchronous database. Properties that are not functions are read as they are.
 * A `null`/`undefined` object stays as it is, so `view?.name()` keeps working.
 *
 * @template T
 * @param {T} obj
 * @returns {T}
 */
export function asyncView(obj) {
  if (obj === null || obj === undefined || (typeof obj !== 'object' && typeof obj !== 'function')) return obj;
  if (VIEWS.has(obj)) return obj;
  const view = new Proxy(obj, {
    get(target, key) {
      if (typeof key === 'string' && !key.endsWith('Async')) {
        const twin = target[`${key}Async`];
        if (typeof twin === 'function') return twin.bind(target);
      }
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  VIEWS.add(view);
  return view;
}

const VIEWS = new WeakSet();
