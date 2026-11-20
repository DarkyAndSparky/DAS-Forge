/**
 * Organizations ("tenants") and access groups (ADR-0012, multi-tenancy).
 *
 *   tenants(id, name, active, created_at)                        an organization; its data is marked with tenant_id
 *   access_groups(id, name, role, created_at)                    a group gives `role` inside the organizations linked to it
 *   access_group_tenants(group_id, tenant_id)                    which organizations a group covers
 *   access_group_members(group_id, user_id)                      who is in the group
 *
 * A user may be in several groups and so work in several organizations (an administrator who serves a group of companies,
 * an accountant of one of them). The effective access is the union of the groups. The platform administrator (the `admin`
 * of the application) sees every organization.
 *
 * `resolveScope` turns the person's identity into a branded scope; the entity store (`createEntityStore`) accepts only such a
 * scope, so the organization filter comes from the server-side session and cannot be written by a request handler.
 */
import { randomUUID } from 'node:crypto';
import { asyncDb } from '../database/async.js';

export class TenantAccessError extends Error {
  constructor(message, code = 'TENANT_FORBIDDEN') { super(message); this.name = 'TenantAccessError'; this.code = code; }
}

const scopes = new WeakSet();
/** True for a scope made by `resolveScope` (the only kind the entity store accepts). */
export const isScope = (x) => typeof x === 'object' && x !== null && scopes.has(x);

const DDL = [
  `CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS access_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS access_group_tenants (group_id TEXT NOT NULL, tenant_id TEXT NOT NULL, PRIMARY KEY (group_id, tenant_id))`,
  `CREATE TABLE IF NOT EXISTS access_group_members (group_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (group_id, user_id))`,
  `CREATE INDEX IF NOT EXISTS idx_access_group_members_user ON access_group_members (user_id)`,
];

const name = (v, what) => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > 120) throw new TypeError(`${what}: a name of 1..120 characters is required`);
  return v.trim();
};

/** @param {object} db @param {{now?: () => Date, newId?: () => string}} [o] */
export function createTenancy(db, { now = () => new Date(), newId = randomUUID } = {}) {
  const a = asyncDb(db);
  let ready = null;
  const ensure = () => (ready ??= (async () => { for (const s of DDL) await a.exec(s); })().catch((e) => { ready = null; throw e; }));
  const stamp = () => now().toISOString();
  const ids = (list, what) => {
    if (!Array.isArray(list) || list.some((x) => typeof x !== 'string' || !x)) throw new TypeError(`${what}: a list of ids is required`);
    return [...new Set(list)];
  };

  const api = {
    ensure,

    async createTenant({ name: n }) {
      await ensure();
      const id = newId();
      await a.run('INSERT INTO tenants (id, name, active, created_at) VALUES (?, ?, 1, ?)', [id, name(n, 'tenant'), stamp()]);
      return id;
    },
    async listTenants({ includeInactive = true } = {}) {
      await ensure();
      const rows = await a.all(`SELECT id, name, active, created_at FROM tenants ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name, id`);
      return rows.map((r) => ({ id: r.id, name: r.name, active: Number(r.active) === 1, createdAt: r.created_at }));
    },
    async renameTenant(id, n) { await ensure(); return (await a.run('UPDATE tenants SET name = ? WHERE id = ?', [name(n, 'tenant'), id])).changes > 0; },
    /** A switched-off organization disappears from every scope (its data stays). */
    async setTenantActive(id, active) { await ensure(); return (await a.run('UPDATE tenants SET active = ? WHERE id = ?', [active ? 1 : 0, id])).changes > 0; },

    async createGroup({ name: n, role, tenantIds = [], userIds = [] }) {
      await ensure();
      if (typeof role !== 'string' || !role) throw new TypeError('group: a role is required');
      const id = newId();
      await a.transaction(async () => {
        await a.run('INSERT INTO access_groups (id, name, role, created_at) VALUES (?, ?, ?, ?)', [id, name(n, 'group'), role, stamp()]);
        await api.setGroupTenants(id, tenantIds);
        await api.setGroupMembers(id, userIds);
      });
      return id;
    },
    async listGroups() {
      await ensure();
      const groups = await a.all('SELECT id, name, role, created_at FROM access_groups ORDER BY name, id');
      const gt = await a.all('SELECT group_id, tenant_id FROM access_group_tenants');
      const gm = await a.all('SELECT group_id, user_id FROM access_group_members');
      return groups.map((g) => ({
        id: g.id, name: g.name, role: g.role, createdAt: g.created_at,
        tenantIds: gt.filter((x) => x.group_id === g.id).map((x) => x.tenant_id),
        userIds: gm.filter((x) => x.group_id === g.id).map((x) => x.user_id),
      }));
    },
    async setGroupTenants(groupId, tenantIds) {
      await ensure();
      const list = ids(tenantIds, 'group tenants');
      await a.transaction(async () => {
        await a.run('DELETE FROM access_group_tenants WHERE group_id = ?', [groupId]);
        for (const t of list) await a.run('INSERT INTO access_group_tenants (group_id, tenant_id) VALUES (?, ?)', [groupId, t]);
      });
    },
    async setGroupMembers(groupId, userIds) {
      await ensure();
      const list = ids(userIds.map(String), 'group members');
      await a.transaction(async () => {
        await a.run('DELETE FROM access_group_members WHERE group_id = ?', [groupId]);
        for (const u of list) await a.run('INSERT INTO access_group_members (group_id, user_id) VALUES (?, ?)', [groupId, u]);
      });
    },
    async setGroupRole(groupId, role) { await ensure(); return (await a.run('UPDATE access_groups SET role = ? WHERE id = ?', [role, groupId])).changes > 0; },
    async deleteGroup(groupId) {
      await ensure();
      await a.transaction(async () => {
        await a.run('DELETE FROM access_group_tenants WHERE group_id = ?', [groupId]);
        await a.run('DELETE FROM access_group_members WHERE group_id = ?', [groupId]);
        await a.run('DELETE FROM access_groups WHERE id = ?', [groupId]);
      });
    },

    /**
     * The scope of one person.
     * @param {object} o
     * @param {string|number} o.userId
     * @param {boolean} [o.platformAdmin] - the application's administrator: every active organization, role 'admin'
     * @param {string|null} [o.activeTenantId] - the organization chosen in the switcher; must be one of the person's. Without it the scope covers all of them ("all mine")
     * @param {(role: string) => Iterable<string>} [o.permissionsOfRole] - for `scope.can()`
     */
    async resolveScope({ userId, platformAdmin = false, activeTenantId = null, permissionsOfRole = () => [] }) {
      await ensure();
      const active = (await a.all('SELECT id FROM tenants WHERE active = 1')).map((r) => r.id);
      const activeSet = new Set(active);
      const rolesByTenant = new Map();
      let tenantIds;
      if (platformAdmin) {
        tenantIds = active;
        for (const t of active) rolesByTenant.set(t, new Set(['admin']));
      } else {
        const rows = await a.all(
          `SELECT gt.tenant_id AS tenant_id, g.role AS role FROM access_group_members m
             JOIN access_groups g ON g.id = m.group_id JOIN access_group_tenants gt ON gt.group_id = g.id
            WHERE m.user_id = ?`,
          [String(userId)],
        );
        for (const r of rows) {
          if (!activeSet.has(r.tenant_id)) continue;
          if (!rolesByTenant.has(r.tenant_id)) rolesByTenant.set(r.tenant_id, new Set());
          rolesByTenant.get(r.tenant_id).add(r.role);
        }
        tenantIds = [...rolesByTenant.keys()];
      }
      if (activeTenantId != null && !tenantIds.includes(activeTenantId)) throw new TenantAccessError('The organization is not available to this user');
      const permsCache = new Map();
      const permsOf = (role) => { if (!permsCache.has(role)) permsCache.set(role, new Set(permissionsOfRole(role))); return permsCache.get(role); };
      const scope = Object.freeze({
        all: platformAdmin === true,
        userId: String(userId),
        tenantIds: Object.freeze([...tenantIds]),
        activeTenantId: activeTenantId ?? null,
        /** The organizations a query may touch: the chosen one, or all of the person's. */
        visibleTenantIds: Object.freeze(activeTenantId != null ? [activeTenantId] : [...tenantIds]),
        rolesIn: (tenantId) => [...(rolesByTenant.get(tenantId) ?? [])],
        /** Whether the person holds `permission` in the organization (the chosen one when omitted; false when none is chosen). */
        can(permission, tenantId = activeTenantId) {
          if (tenantId == null) return false;
          if (platformAdmin) return true;
          return [...(rolesByTenant.get(tenantId) ?? [])].some((r) => permsOf(r).has(permission));
        },
      });
      scopes.add(scope);
      return scope;
    },
  };
  return api;
}
