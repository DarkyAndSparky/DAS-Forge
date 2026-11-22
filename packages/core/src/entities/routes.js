/**
 * JSON API of one entity, built from its descriptor and store (ADR-0012, B2).
 *
 *   GET    {basePath}             list (?page, size, sort, q, filter[field]=v, includeDeleted=1)
 *   GET    {basePath}/:id         one record
 *   POST   {basePath}             create (in the active organization)
 *   PATCH  {basePath}/:id         change (If-Match: <version> or body field `_version` = optimistic lock)
 *   DELETE {basePath}/:id         delete (soft when the entity has softDelete)
 *   POST   {basePath}/:id/restore bring back
 *
 * The app supplies `getScope(req)` (a scope from `tenancy.resolveScope`, usually from the session) and a JSON body parser; CSRF and
 * login stay with the app's own middleware. Every operation checks the right named in `entity.permissions` in the record's organization.
 * Errors: 400 organization not chosen / bad query, 403 no right or organization, 404 not found (also for another organization's record),
 * 409 version or uniqueness conflict, 422 validation (`errors: [{path, code, params}]`).
 */
import { EntityNotFoundError, EntityValidationError, EntityConflictError, TenantRequiredError } from './store.js';
import { TenantAccessError } from '../tenancy/index.js';

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/**
 * `filter[field]=value` read from the query by the code itself: Express 5 parses `a[b]=c` into an object only when the app turned
 * the "extended" query parser on, and the default parser would silently drop the filter. Both shapes are accepted. A value is a text
 * or a list of up to 50 texts; anything else (a nested object such as `filter[x][$ne]=1`) is refused.
 */
export function readFilter(query) {
  const out = Object.create(null);
  const put = (name, v) => {
    if (!NAME.test(name)) throw new EntityValidationError([{ path: 'filter', code: 'not_filterable' }]);
    const ok = (x) => typeof x === 'string' && x.length <= 200;
    if (!(ok(v) || (Array.isArray(v) && v.length <= 50 && v.every(ok)))) throw new EntityValidationError([{ path: `filter.${name}`, code: 'type' }]);
    out[name] = v;
  };
  for (const [k, v] of Object.entries(query ?? {})) {
    const m = /^filter\[(.*)\]$/.exec(k);
    if (m) put(m[1], v);
  }
  const nested = query?.filter;
  if (nested !== undefined) {
    if (!isPlain(nested)) throw new EntityValidationError([{ path: 'filter', code: 'type' }]);
    for (const [k, v] of Object.entries(nested)) put(k, v);
  }
  return out;
}
const isPlain = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

const bad = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

function mapError(res, e) {
  if (e instanceof EntityValidationError) return bad(res, 422, 'validation', { errors: e.errors });
  if (e instanceof EntityNotFoundError) return bad(res, 404, 'not_found');
  if (e instanceof EntityConflictError) return bad(res, 409, 'conflict', { message: e.message });
  if (e instanceof TenantRequiredError) return bad(res, 400, 'tenant_required');
  if (e instanceof TenantAccessError) return bad(res, 403, 'forbidden');
  return null;
}

/**
 * @param {object} app Express app or router (needs get/post/patch/delete)
 * @param {{entity: object, store: object, basePath?: string, getScope: (req:object)=>Promise<object>|object}} o
 */
export function mountEntityApi(app, { entity, store, basePath = `/api/${entity.table}`, getScope }) {
  if (typeof getScope !== 'function') throw new TypeError('mountEntityApi: getScope(req) is required');
  const perms = entity.permissions ?? {};
  const tenanted = entity.tenant !== 'global';

  // right in the organizations the person works in (a list), or in one organization (a record)
  // the organizations where the person may read: the list query itself is limited to them, so `total` and the page count never count other organizations' records
  const readableTenants = (s, p) => (!tenanted || !p || s.all ? undefined : s.visibleTenantIds.filter((x) => s.can(p, x)));
  const allowedAnywhere = (scope, p) => !p || scope.all || (tenanted ? scope.visibleTenantIds.some((t) => scope.can(p, t)) : scope.can(p));
  const allowedIn = (scope, p, rec) => !p || scope.all || (tenanted ? scope.can(p, rec.tenantId) : scope.can(p));

  const wrap = (fn) => async (req, res) => {
    try {
      const scope = await getScope(req);
      if (!scope) return bad(res, 401, 'unauthorized');
      return await fn(req, res, scope);
    } catch (e) {
      if (mapError(res, e)) return undefined;
      throw e;
    }
  };
  const idOf = (req) => (entity.idType === 'int' ? Number(req.params.id) : String(req.params.id));
  const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : null);
  const versionOf = (req, body) => {
    const h = req.headers?.['if-match']; const b = body?._version;
    if (body) delete body._version;
    const v = h ?? b;
    return v === undefined || v === null || v === '' ? undefined : Number(String(v).replace(/"/g, ''));
  };

  app.get(basePath, wrap(async (req, res, scope) => {
    if (!allowedAnywhere(scope, perms.read)) return bad(res, 403, 'forbidden');
    const q = req.query ?? {};
    const filter = readFilter(q);
    const out = await store.list(scope, { onlyTenants: readableTenants(scope, perms.read), page: q.page, size: q.size, sort: q.sort ? String(q.sort).split(',') : undefined, filter, q: typeof q.q === 'string' ? q.q : '', includeDeleted: q.includeDeleted === '1' && allowedAnywhere(scope, perms.restore ?? perms.delete) });
    // records of organizations where the person has no read right are not shown
    const items = out.items.filter((r) => allowedIn(scope, perms.read, r));
    return res.json({ ...out, items });
  }));

  app.get(`${basePath}/:id`, wrap(async (req, res, scope) => {
    const rec = await store.get(scope, idOf(req));
    if (!allowedIn(scope, perms.read, rec)) return bad(res, 404, 'not_found');
    return res.json(rec);
  }));

  app.post(basePath, wrap(async (req, res, scope) => {
    const body = bodyOf(req);
    if (!body) return bad(res, 400, 'bad_body');
    if (tenanted && scope.activeTenantId == null && !scope.all) throw new TenantRequiredError();
    if (!allowedIn(scope, perms.create, { tenantId: scope.activeTenantId })) return bad(res, 403, 'forbidden');
    const rec = await store.create(scope, body, { actor: scope.userId });
    return res.status(201).json(rec);
  }));

  app.patch(`${basePath}/:id`, wrap(async (req, res, scope) => {
    const body = bodyOf(req);
    if (!body) return bad(res, 400, 'bad_body');
    const id = idOf(req);
    const cur = await store.get(scope, id);
    if (!allowedIn(scope, perms.update, cur)) return bad(res, 403, 'forbidden');
    const expectedVersion = versionOf(req, body);
    return res.json(await store.update(scope, id, body, { expectedVersion, actor: scope.userId }));
  }));

  app.delete(`${basePath}/:id`, wrap(async (req, res, scope) => {
    const id = idOf(req);
    const cur = await store.get(scope, id);
    if (!allowedIn(scope, perms.delete, cur)) return bad(res, 403, 'forbidden');
    await store.remove(scope, id, { actor: scope.userId });
    return res.status(204).end();
  }));

  app.post(`${basePath}/:id/restore`, wrap(async (req, res, scope) => {
    const id = idOf(req);
    const cur = await store.get(scope, id, { includeDeleted: true });
    if (!allowedIn(scope, perms.restore ?? perms.delete, cur)) return bad(res, 403, 'forbidden');
    return res.json(await store.restore(scope, id, { actor: scope.userId }));
  }));

  return { basePath };
}
