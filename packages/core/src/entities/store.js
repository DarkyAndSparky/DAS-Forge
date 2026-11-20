/**
 * The access layer of an entity (ADR-0012): every read, write and delete of its records goes through here.
 *
 * - The organization filter is added by the layer itself from a scope made by `tenancy.resolveScope` (a plain object is refused),
 *   so a request handler cannot turn it off or widen it. A record of another organization is "not found", not "forbidden".
 * - Writes: validation by the descriptor, one transaction (hooks inside: an exception rolls everything back), version check
 *   (`optimisticLock`), soft delete (`softDelete`). Queries are constants with `?`; only names from the descriptor are put into SQL.
 * - Lists: filters only on `filterable` fields, search only on `searchable` ones (LIKE with escaping), sort only on `sortable` ones,
 *   page size up to 200.
 * - Permissions are not checked here (the route layer does, with `entity.permissions`); the layer guarantees the data boundary.
 */
import { randomUUID } from 'node:crypto';
import { asyncDb } from '../database/async.js';
import { isScope } from '../tenancy/tenancy.js';

export class EntityNotFoundError extends Error { constructor(entity, id) { super(`${entity} ${id} not found`); this.name = 'EntityNotFoundError'; this.code = 'NOT_FOUND'; } }
export class EntityValidationError extends Error { constructor(errors) { super(`validation failed: ${errors.map((e) => `${e.path}:${e.code}`).join(', ')}`); this.name = 'EntityValidationError'; this.code = 'VALIDATION'; this.errors = errors; } }
export class EntityConflictError extends Error { constructor(message) { super(message); this.name = 'EntityConflictError'; this.code = 'CONFLICT'; } }
export class TenantRequiredError extends Error { constructor() { super('Choose an organization first'); this.name = 'TenantRequiredError'; this.code = 'TENANT_REQUIRED'; } }

const MAX_PAGE = 200;
const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

/** @param {object} db @param {object} entity - from defineEntity @param {{now?: () => Date, newId?: () => string}} [o] */
export function createEntityStore(db, entity, { now = () => new Date(), newId = randomUUID } = {}) {
  const a = asyncDb(db);
  const tenanted = entity.tenant === 'tenant';
  const { fields, features, table } = entity;
  const col = (n) => (n === 'createdAt' ? 'created_at' : n === 'updatedAt' ? 'updated_at' : n === 'id' ? 'id' : fields[n].column);
  const hook = async (name, ctx) => { if (entity.hooks[name]) await entity.hooks[name](ctx); };
  const stamp = () => now().toISOString();

  const needScope = (scope) => { if (!isScope(scope)) throw new TypeError('A scope made by tenancy.resolveScope is required'); };

  /** WHERE parts and params that fence the query to the person's organizations and to live records. */
  function fence(scope, { withDeleted = false } = {}) {
    const where = []; const params = [];
    if (tenanted && !(scope.all && scope.activeTenantId == null)) {
      const ids = scope.visibleTenantIds;
      if (ids.length === 0) where.push('1 = 0');
      else { where.push(`tenant_id IN (${ids.map(() => '?').join(', ')})`); params.push(...ids); }
    }
    if (features.softDelete && !withDeleted) where.push('deleted_at IS NULL');
    return { where, params };
  }
  const shape = (row) => entity.publicShape(entity.fromStorage(row));
  const raw = (row) => entity.fromStorage(row);
  const flat = (v) => { const { attrs, ...rest } = v ?? {}; return { ...rest, ...(attrs ?? {}) }; }; // variant fields live in `attrs`; validation takes them flat

  async function load(scope, id, q = a, { withDeleted = false } = {}) {
    needScope(scope);
    const f = fence(scope, { withDeleted });
    const row = await q.get(`SELECT * FROM ${table} WHERE id = ?${f.where.length ? ` AND ${f.where.join(' AND ')}` : ''}`, [id, ...f.params]);
    if (!row) throw new EntityNotFoundError(entity.name, id);
    return row;
  }

  return {
    entity,

    /** @returns {Promise<{items: object[], total: number, page: number, size: number}>} */
    async list(scope, { page = 1, size = entity.list.pageSize, sort = entity.list.sort, filter = {}, q = '', includeDeleted = false } = {}) {
      needScope(scope);
      const p = Math.max(1, Math.trunc(Number(page)) || 1);
      const s = Math.min(MAX_PAGE, Math.max(1, Math.trunc(Number(size)) || entity.list.pageSize));
      const f = fence(scope, { withDeleted: includeDeleted });
      const where = [...f.where]; const params = [...f.params];
      for (const [k, v] of Object.entries(filter)) {
        const fld = fields[k];
        if (!fld || !fld.filterable) throw new EntityValidationError([{ path: `filter.${k}`, code: 'not_filterable' }]);
        const vals = Array.isArray(v) ? v : [v];
        const stored = [];
        for (const x of vals) {
          if (x === null) continue;
          const r = fld.def.validate(x, fld);
          if (!r.ok) throw new EntityValidationError([{ path: `filter.${k}`, code: r.code }]);
          stored.push(fld.def.toStorage ? fld.def.toStorage(r.value, fld) : r.value);
        }
        const hasNull = vals.includes(null);
        const parts = [];
        if (stored.length) { parts.push(`${fld.column} IN (${stored.map(() => '?').join(', ')})`); params.push(...stored); }
        if (hasNull) parts.push(`${fld.column} IS NULL`);
        where.push(parts.length ? `(${parts.join(' OR ')})` : '1 = 0');
      }
      if (q) {
        const sf = Object.values(fields).filter((x) => x.searchable);
        if (sf.length) {
          where.push(`(${sf.map((x) => `${x.column} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
          for (let i = 0; i < sf.length; i += 1) params.push(`%${likeEscape(q)}%`);
        }
      }
      const order = (Array.isArray(sort) ? sort : [sort]).map((x) => {
        const desc = String(x).startsWith('-'); const n = String(x).replace(/^-/, '');
        const ok = n === 'id' || n === 'createdAt' || n === 'updatedAt' || fields[n]?.sortable;
        if (!ok) throw new EntityValidationError([{ path: 'sort', code: 'not_sortable' }]);
        return `${col(n)} ${desc ? 'DESC' : 'ASC'}`;
      });
      order.push('id ASC'); // a stable order makes pages repeatable
      const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      const total = Number((await a.get(`SELECT COUNT(*) AS n FROM ${table}${w}`, params)).n);
      const rows = await a.all(`SELECT * FROM ${table}${w} ORDER BY ${order.join(', ')} LIMIT ? OFFSET ?`, [...params, s, (p - 1) * s]);
      return { items: rows.map(shape), total, page: p, size: s };
    },

    async get(scope, id, { includeDeleted = false } = {}) { return shape(await load(scope, id, a, { withDeleted: includeDeleted })); },

    /** Creates a record in the chosen organization (a person with several must choose one). Returns the public shape. */
    async create(scope, input, { actor } = {}) {
      needScope(scope);
      if (tenanted && scope.activeTenantId == null) throw new TenantRequiredError();
      if (tenanted && !scope.all && !scope.tenantIds.includes(scope.activeTenantId)) throw new EntityNotFoundError('tenant', scope.activeTenantId);
      const r = entity.validate(input, { mode: 'create' });
      if (!r.ok) throw new EntityValidationError(r.errors);
      return a.transaction(async (q) => {
        const ctx = { entity, scope, actor, value: r.value };
        await hook('beforeCreate', ctx);
        const check = entity.validate(flat(ctx.value), { mode: 'create' }); // a hook may have changed the value: it is checked again
        if (!check.ok) throw new EntityValidationError(check.errors);
        const row = entity.toStorage(check.value);
        const t = stamp();
        const cols = [...(tenanted ? ['tenant_id'] : []), ...Object.keys(row), 'created_at', 'updated_at', ...(features.optimisticLock ? ['version'] : [])];
        const vals = [...(tenanted ? [scope.activeTenantId] : []), ...Object.values(row), t, t, ...(features.optimisticLock ? [1] : [])];
        let id;
        if (entity.idType === 'text') { id = newId(); cols.unshift('id'); vals.unshift(id); }
        const res = await q.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, vals);
        if (entity.idType !== 'text') id = Number(res.lastInsertRowid);
        const created = await load(scope, id, q);
        await hook('afterCreate', { entity, scope, actor, record: raw(created) });
        return shape(created);
      }, { mode: 'immediate' });
    },

    /**
     * Changes the given fields. `expectedVersion` (with `optimisticLock`) must equal the stored version, else EntityConflictError.
     * Fields of a variant (`attrs`) are merged into the stored ones.
     */
    async update(scope, id, patch, { expectedVersion, actor } = {}) {
      needScope(scope);
      return a.transaction(async (q) => {
        const current = raw(await load(scope, id, q));
        if (features.optimisticLock && expectedVersion !== undefined && Number(expectedVersion) !== Number(current.version)) throw new EntityConflictError(`${entity.name} ${id} was changed by someone else (version ${current.version})`);
        const r = entity.validate(patch, { mode: 'update', current });
        if (!r.ok) throw new EntityValidationError(r.errors);
        const ctx = { entity, scope, actor, record: current, patch: r.value };
        await hook('beforeUpdate', ctx);
        const check = entity.validate(flat(ctx.patch), { mode: 'update', current });
        if (!check.ok) throw new EntityValidationError(check.errors);
        const next = { ...check.value };
        if (next.attrs) next.attrs = { ...(current.attrs ?? {}), ...next.attrs };
        const row = entity.toStorage(next);
        const sets = [...Object.keys(row).map((c) => `${c} = ?`), 'updated_at = ?', ...(features.optimisticLock ? ['version = version + 1'] : [])];
        const params = [...Object.values(row), stamp()];
        const f = fence(scope);
        const res = await q.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?${features.optimisticLock ? ' AND version = ?' : ''}${f.where.length ? ` AND ${f.where.join(' AND ')}` : ''}`,
          [...params, id, ...(features.optimisticLock ? [current.version] : []), ...f.params]);
        if (res.changes === 0) throw new EntityConflictError(`${entity.name} ${id} was changed by someone else`);
        const updated = await load(scope, id, q);
        await hook('afterUpdate', { entity, scope, actor, record: raw(updated), before: current });
        return shape(updated);
      }, { mode: 'immediate' });
    },

    /** Soft delete (`deleted_at`) when the entity has `softDelete`, else a real delete. */
    async remove(scope, id, { actor } = {}) {
      needScope(scope);
      await a.transaction(async (q) => {
        const current = raw(await load(scope, id, q));
        await hook('beforeDelete', { entity, scope, actor, record: current });
        const f = fence(scope);
        const w = `WHERE id = ?${f.where.length ? ` AND ${f.where.join(' AND ')}` : ''}`;
        if (features.softDelete) await q.run(`UPDATE ${table} SET deleted_at = ?, updated_at = ? ${w}`, [stamp(), stamp(), id, ...f.params]);
        else await q.run(`DELETE FROM ${table} ${w}`, [id, ...f.params]);
        await hook('afterDelete', { entity, scope, actor, record: current });
      }, { mode: 'immediate' });
    },

    /** Brings a soft-deleted record back (only for entities with `softDelete`). */
    async restore(scope, id, { actor } = {}) {
      needScope(scope);
      if (!features.softDelete) throw new TypeError(`${entity.name} has no soft delete`);
      return a.transaction(async (q) => {
        const row = await load(scope, id, q, { withDeleted: true });
        if (!row.deleted_at) return shape(row);
        const f = fence(scope, { withDeleted: true });
        try {
          await q.run(`UPDATE ${table} SET deleted_at = NULL, updated_at = ?${features.optimisticLock ? ', version = version + 1' : ''} WHERE id = ?${f.where.length ? ` AND ${f.where.join(' AND ')}` : ''}`, [stamp(), id, ...f.params]);
        } catch (e) {
          if (/UNIQUE/i.test(String(e?.message))) throw new EntityConflictError(`${entity.name} ${id} cannot be restored: a live record with the same unique value exists`);
          throw e;
        }
        void actor;
        return shape(await load(scope, id, q));
      }, { mode: 'immediate' });
    },

    /** Creates the table and indexes of the entity (the application calls it once at start, or a migration does). */
    async ensureTable() { for (const s of entity.ddl()) await a.exec(s); },
  };
}
