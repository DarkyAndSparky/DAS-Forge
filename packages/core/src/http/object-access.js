import { sendError } from './respond.js';
import { parseId } from '../util/parse-id.js';
import { normalizeLimit } from '../database/identifiers.js';
import { markGuard } from './route-guards.js';

/**
 * Object-level access control (OWASP API1 / A01: IDOR, BOLA). `requirePermission` says "may this user use this kind of route";
 * this guard says "may this user touch THIS record".
 *
 * ```js
 * // DENIED_ACTION is your own audit action code, e.g. 'orders.denied' registered with registerEvents
 * router.get('/orders/:id', http.requireObjectAccess({
 *   load: (req, id) => db.get('SELECT * FROM orders WHERE id = ?', [id]),
 *   allow: (user, order) => order.owner_id === user.id || user.permissions.has('orders.read.all'),
 *   onDenied: (req, info) => audit.log(db, { actor: req.user?.username, action: DENIED_ACTION, entity: 'order', entityId: info.id, result: 'denied', requestId: req.id }),
 * }), handler);
 * ```
 * - the id is read with `parseId`; anything but a plain positive number is 404;
 * - a missing record and a record the user may not see give THE SAME answer (404 by default), so ids cannot be probed;
 * - nothing is read from a body or a header, only `req.params[param]` and `req.user` (set by `attachUser`);
 * - on success the record is in `req.object` (or `req[into]`), so the handler does not load it again.
 * `onDenied` gets `{ id, reason: 'invalid_id' | 'not_found' | 'forbidden' }` and never breaks the response.
 * @param {{ load:(req:any, id:number)=>any, allow:(user:any, object:any, req:any)=>boolean|Promise<boolean>, param?:string, into?:string,
 *   status?:403|404, onDenied?:(req:any, info:{id:any, reason:string})=>void, parse?:(v:unknown)=>any }} options
 */
export function requireObjectAccess({ load, allow, param = 'id', into = 'object', status = 404, onDenied, parse = parseId }) {
  if (typeof load !== 'function' || typeof allow !== 'function') throw new TypeError('requireObjectAccess: `load` and `allow` are required functions');
  if (status !== 404 && status !== 403) throw new RangeError('requireObjectAccess: status must be 404 or 403');
  const deny = (req, res, id, reason) => {
    try { onDenied?.(req, { id, reason }); } catch { /* a reporting hook must never change the answer */ }
    return sendError(req, res, status, { error: status === 404 ? 'NOT_FOUND' : 'FORBIDDEN', fields: [] });
  };
  return markGuard(async (req, res, next) => {
    try {
      if (!req.user) return sendError(req, res, 401, { error: 'UNAUTHENTICATED', fields: [] });
      const raw = req.params?.[param];
      const id = parse(raw);
      if (id === null || id === undefined) return deny(req, res, raw, 'invalid_id');
      const object = await load(req, id);
      if (object === null || object === undefined) return deny(req, res, id, 'not_found');
      if ((await allow(req.user, object, req)) !== true) return deny(req, res, id, 'forbidden');
      req[into] = object;
      return next();
    } catch (err) {
      return next(err);
    }
  }, 'object');
}

/**
 * Page size and offset from a query string, with a hard ceiling: nobody gets "all rows" with `?limit=1000000`.
 * @returns {{limit:number, offset:number}}
 */
export function readPaging(query, { fallback = 25, max = 100 } = {}) {
  const q = query ?? {};
  const limit = normalizeLimit(q.limit ?? q.pageSize ?? q.per_page, { fallback, max });
  const offset = Math.max(0, Math.min(Math.trunc(Number(q.offset)) || 0, 1_000_000_000));
  return { limit, offset };
}
