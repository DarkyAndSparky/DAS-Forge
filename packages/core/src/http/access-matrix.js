/**
 * The "two accounts" test for routes that take an id (OWASP WSTG: testing for IDOR). For every route the check is run as three people:
 * the owner (must get in), another signed-in user (must NOT get the object), nobody (must be asked to sign in).
 * The app supplies `request`, which sends one request as a given actor and returns `{ status }`; so it works with supertest,
 * `fetch` against a started server, or a direct call of the handler.
 *
 * ```js
 * const r = await http.checkAccessMatrix({
 *   routes: [{ method: 'GET', path: `/orders/${order.id}` }, { method: 'POST', path: `/orders/${order.id}/cancel` }],
 *   request: ({ method, path, as }) => agents[as][method.toLowerCase()](path).then((x) => ({ status: x.status })),
 * });
 * expect(r.violations).toEqual([]);
 * ```
 * @param {{ routes:{method:string, path:string, ownerOk?:(status:number)=>boolean}[], request:(a:{method:string,path:string,as:'owner'|'other'|'anonymous'})=>Promise<{status:number}> }} options
 * @returns {Promise<{ok:boolean, checked:number, violations:{method:string, path:string, as:string, status:number, problem:string}[]}>}
 */
export async function checkAccessMatrix({ routes, request }) {
  if (!Array.isArray(routes) || routes.length === 0) throw new TypeError('checkAccessMatrix: routes must be a non-empty array');
  if (typeof request !== 'function') throw new TypeError('checkAccessMatrix: request must be a function');
  const violations = [];
  let checked = 0;
  for (const route of routes) {
    const { method, path } = route;
    const ownerOk = route.ownerOk ?? ((s) => s >= 200 && s < 400);
    const cases = [
      ['owner', ownerOk, 'the owner was refused'],
      ['other', (s) => s === 403 || s === 404, 'another user was not refused with 403/404'],
      ['anonymous', (s) => s === 401 || s === 403 || s === 302 || s === 303, 'a request without sign-in was not sent to sign in'],
    ];
    for (const [as, good, problem] of cases) {
      const { status } = await request({ method, path, as });
      checked++;
      if (!good(Number(status))) violations.push({ method, path, as, status: Number(status), problem });
    }
  }
  return { ok: violations.length === 0, checked, violations };
}

/** Same check, but throws one readable error that lists every violation (for a test or a start-up self-check). */
export async function assertAccessMatrix(options) {
  const r = await checkAccessMatrix(options);
  if (!r.ok) throw new Error(`access matrix: ${r.violations.length} violation(s):\n${r.violations.map((v) => `  ${v.method} ${v.path} as ${v.as} -> ${v.status}: ${v.problem}`).join('\n')}`);
  return r;
}
