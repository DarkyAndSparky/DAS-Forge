import { describe, it, expect, beforeEach } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createTenancy } from '../src/tenancy/index.js';
import { defineEntity, field, createEntityStore, mountEntityPages } from '../src/entities/index.js';

function fakeApp() {
  const routes = [];
  const add = (m) => (p, h) => routes.push({ m, p, h });
  const call = async (m, url, { form, query = {}, user } = {}) => {
    const path = url;
    for (const r of routes) {
      if (r.m !== m) continue;
      const names = []; const re = new RegExp(`^${r.p.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
      const mt = re.exec(path); if (!mt) continue;
      const out = { status: 200, html: '', location: null };
      const res = { locals: {}, status(c) { out.status = c; return this; }, send(b) { out.html = String(b); return this; }, redirect(c, u) { out.status = c; out.location = u; return this; } };
      await r.h({ params: Object.fromEntries(names.map((n, i) => [n, mt[i + 1]])), body: form, query, user, locale: 'ru' }, res);
      return out;
    }
    throw new Error(`no route ${m} ${url}`);
  };
  return { app: { get: add('GET'), post: add('POST') }, call };
}

describe('entity HTML pages', () => {
  let call; let ids;
  beforeEach(async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    let n = 0; const ten = createTenancy(db, { newId: () => `t${++n}` });
    const a = await ten.createTenant({ name: 'A' }); const b = await ten.createTenant({ name: 'B' });
    await ten.createGroup({ name: 'acc', role: 'accountant', tenantIds: [a], userIds: ['acc'] });
    await ten.createGroup({ name: 'sys', role: 'sysadmin', tenantIds: [a, b], userIds: ['sys'] });
    ids = { a, b };
    const entity = defineEntity({ name: 'asset', table: 'assets', idType: 'text', label: { ru: ['Актив', 'Активы'], en: ['Asset', 'Assets'] },
      permissions: { read: 'r', create: 'w', update: 'w', delete: 'd', restore: 'd' },
      fields: { title: field.text({ required: true, max: 20, searchable: true }), price: field.money({ nullable: true }), active: field.bool({ default: true }), kind: field.enum(['laptop', 'router'], { nullable: true }), pass: field.secret({ nullable: true }) },
      variants: { by: 'kind', cases: { router: { fields: { ip: field.ip({ nullable: true }) } }, laptop: { fields: { host: field.text({ nullable: true }) } } } },
      features: { softDelete: true } });
    let k = 0; const store = createEntityStore(db, entity, { newId: () => `r${++k}` }); await store.ensureTable();
    const perms = { accountant: ['r'], sysadmin: ['r', 'w', 'd'] };
    const f = fakeApp(); call = f.call;
    mountEntityPages(f.app, { entity, store, getScope: (req) => (req.user ? ten.resolveScope({ userId: req.user.id, activeTenantId: req.user.tenant ?? null, permissionsOfRole: (r) => perms[r] ?? [] }) : null),
      render: (req, res, { title, bodyHtml }) => res.send(`<h1>${title}</h1>${bodyHtml}`), csrfField: () => '<input type="hidden" name="_csrf" value="T">' });
  });
  const sys = (t) => ({ id: 'sys', tenant: t });

  it('401 without a person; 403 without the right to create', async () => {
    expect((await call('GET', '/assets')).status).toBe(401);
    expect((await call('GET', '/assets/new', { user: { id: 'acc', tenant: ids.a } })).status).toBe(403);
  });
  it('creates through the form (money in major units, checkbox, variant fields of the chosen case only) and lists it', async () => {
    const c = await call('POST', '/assets', { user: sys(ids.a), form: { f_title: 'Router 1', f_price: '12,50', f_active: ['0', '1'], f_kind: 'router', f_ip: '10.0.0.1', f_host: 'ignored', f_pass: 'pw' } });
    expect(c.status).toBe(303);
    const l = await call('GET', '/assets', { user: sys(ids.a) });
    expect(l.html).toContain('Router 1');
    expect(l.html).toContain('12.50');
    expect(l.html).toContain('data-paged="ent-asset"');
    expect(l.html).not.toContain('pw');
    expect((await call('GET', '/assets', { user: sys(ids.a), query: { q: 'nomatch' } })).html).toContain('Записей нет');
  });
  it('shows validation errors next to the field and keeps what was typed', async () => {
    const r = await call('POST', '/assets', { user: sys(ids.a), form: { f_title: '', f_kind: 'router', f_ip: 'zzz' } });
    expect(r.status).toBe(422);
    expect(r.html).toContain('Обязательное поле');
    expect(r.html).toContain('Неверное значение');
    expect(r.html).toContain('value="zzz"');
  });
  it('escapes what the record holds', async () => {
    await call('POST', '/assets', { user: sys(ids.a), form: { f_title: '<b>x</b>' } });
    const l = await call('GET', '/assets', { user: sys(ids.a) });
    expect(l.html).not.toContain('<b>x</b>');
    expect(l.html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
  it('edit page: the secret is never printed; an empty secret keeps the old one; a stale version is a 409', async () => {
    await call('POST', '/assets', { user: sys(ids.a), form: { f_title: 'T', f_pass: 'topsecret' } });
    const e = await call('GET', '/assets/r1', { user: sys(ids.a) });
    expect(e.html).not.toContain('topsecret');
    expect(e.html).toContain('name="_version" value="1"');
    expect((await call('POST', '/assets/r1', { user: sys(ids.a), form: { f_title: 'T2', f_pass: '', _version: '1' } })).status).toBe(303);
    expect((await call('POST', '/assets/r1', { user: sys(ids.a), form: { f_title: 'T3', _version: '1' } })).status).toBe(409);
  });
  it('another organization is 404; delete and restore go through the forms', async () => {
    await call('POST', '/assets', { user: sys(ids.b), form: { f_title: 'Beta' } });
    expect((await call('GET', '/assets/r1', { user: { id: 'acc', tenant: ids.a } })).status).toBe(404);
    expect((await call('POST', '/assets/r1/delete', { user: { id: 'acc', tenant: ids.a } })).status).toBe(404);
    expect((await call('POST', '/assets/r1/delete', { user: sys(ids.b) })).status).toBe(303);
    expect((await call('GET', '/assets', { user: sys(ids.b) })).html).not.toContain('Beta');
    expect((await call('GET', '/assets', { user: sys(ids.b), query: { deleted: '1' } })).html).toContain('Удалена');
    expect((await call('POST', '/assets/r1/restore', { user: sys(ids.b) })).status).toBe(303);
    expect((await call('GET', '/assets', { user: sys(ids.b) })).html).toContain('Beta');
  });
});
