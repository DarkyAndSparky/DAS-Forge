import { describe, it, expect } from 'vitest';
import { pageParams, pageUrl, pagerHtml, pagerFor, PAGE_SIZE } from '../src/admin/paging.js';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createAdmin } from '../src/admin/index.js';
import { createIncidentRegister } from '../src/privacy/incidents.js';

describe('paging helpers', () => {
  it('reads the page number safely', () => {
    expect(pageParams({ query: {} })).toEqual({ page: 1, size: PAGE_SIZE, offset: 0 });
    expect(pageParams({ query: { page: '3' } }).offset).toBe(2 * PAGE_SIZE);
    for (const bad of ['0', '-4', 'abc', '1e9', '']) expect(pageParams({ query: { page: bad } }).page).toBe(1);
  });

  it('keeps other query values and sets or drops the page', () => {
    expect(pageUrl('/admin/users', { q: 'ann', page: '2' }, 'page', 3)).toBe('/admin/users?q=ann&page=3');
    expect(pageUrl('/admin/users', { q: 'ann', page: '2' }, 'page', undefined)).toBe('/admin/users?q=ann');
    expect(pageUrl('/admin/users', {}, 'page', undefined)).toBe('/admin/users');
  });

  it('renders links, a hidden expand button and the script once', () => {
    const html = pagerHtml({ name: 'users', shown: 25, total: 60, prevUrl: '', nextUrl: '/admin/users?page=2', locale: 'en', nonce: 'N1' });
    expect(html).toContain('Showing 25 of 60');
    expect(html).toContain('rel="next" href="/admin/users?page=2"');
    expect(html).toContain('data-expand="users" hidden');
    expect(html).toContain('<script nonce="N1">');
    expect(pagerHtml({ name: 'b', shown: 1, total: 1, locale: 'ru', withScript: false })).not.toContain('<script');
  });

  it('has no expand button and no links on a single page, and speaks Russian', () => {
    const html = pagerHtml({ name: 'x', shown: 3, total: 3, locale: 'ru', withScript: false });
    expect(html).toContain('Показано 3 из 3');
    expect(html).not.toContain('data-expand');
    expect(html).not.toContain('rel="next"');
  });

  it('pagerFor links back and forward from the page position', () => {
    const req = { query: { q: 'a' } };
    const mid = pagerFor({ req, path: '/p', name: 'l', page: 2, size: 25, count: 25, total: 80, locale: 'en' });
    expect(mid).toContain('rel="prev" href="/p?q=a"');
    expect(mid).toContain('rel="next" href="/p?q=a&amp;page=3"');
    const last = pagerFor({ req, path: '/p', name: 'l', page: 4, size: 25, count: 5, total: 80, locale: 'en' });
    expect(last).not.toContain('rel="next"');
  });
});

describe('a long list is paged by the admin sections', () => {
  const admin = { id: 1, username: 'root', permissions: ['admin.access'] };
  function call(chain, req) {
    return new Promise((resolve) => {
      req.on ??= function () { return this; };
      const res = { code: 200, body: '', locals: {}, set() { return this; }, type() { return this; }, status(c) { this.code = c; return this; } };
      res.send = (b) => { res.body = b; resolve(res); return res; };
      res.end = () => resolve(res);
      res.redirect = (c, loc) => { res.location = loc; resolve(res); return res; };
      let i = 0;
      const next = () => { const h = chain[i++]; if (h) Promise.resolve(h(req, res, next)).catch((e) => { res.body = String(e); resolve(res); }); };
      next();
    });
  }

  it('colours the severity of incidents and raises an alert on the overview: red for high or overdue, amber for the rest, none when all are closed', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    ensureAuthTables(db);
    const reg = createIncidentRegister(db);
    const routes = {};
    createAdmin({ db, incidents: reg }).mount({ get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } }, { requireAuth: () => (r, s, n) => n(), requirePermission: () => (r, s, n) => n() });
    const overview = async () => (await call(routes['GET /admin'], { user: admin, query: {}, headers: {} })).body;
    expect(await overview()).not.toContain('Открытые инциденты безопасности');
    const low = reg.declare({ title: 'Low one', severity: 'low' });
    let body = await overview();
    expect(body).toContain('Открытые инциденты безопасности: 1');
    expect(body).toContain('border-left:4px solid var(--adm-warn);text-decoration:none;color:inherit"><strong>Открытые инциденты');
    reg.declare({ title: 'High one', severity: 'high' });
    body = await overview();
    expect(body).toContain('border-left:4px solid var(--adm-danger);text-decoration:none;color:inherit"><strong>Открытые инциденты безопасности: 2');
    expect(body).toContain('высокой важности: 1');
    const list = (await call(routes['GET /admin/incidents'], { user: admin, query: {}, headers: {} })).body;
    expect(list).toMatch(/adm-badge danger">Высокая/);
    expect(list).toMatch(/adm-badge info">Низкая/);
    reg.update(low.id, { status: 'closed' });
    reg.update(reg.list({}).find((i) => i.title === 'High one').id, { status: 'closed' });
    expect(await overview()).not.toContain('Открытые инциденты безопасности');
  });

  it('shows 25 incidents per page with a pager, and the next page has the rest', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    ensureAuthTables(db);
    const reg = createIncidentRegister(db);
    for (let n = 1; n <= 30; n++) reg.declare({ title: `Incident ${n}` });
    const routes = {};
    createAdmin({ db, incidents: reg }).mount({ get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } }, { requireAuth: () => (r, s, n) => n(), requirePermission: () => (r, s, n) => n() });
    let r = await call(routes['GET /admin/incidents'], { user: admin, query: {}, headers: {} });
    expect(r.body.match(/Incident \d+/g)).toHaveLength(25);
    expect(r.body).toContain('data-paged="incidents"');
    expect(r.body).toContain('data-next="/admin/incidents?page=2"');
    r = await call(routes['GET /admin/incidents'], { user: admin, query: { page: '2' }, headers: {} });
    expect(r.body.match(/Incident \d+/g)).toHaveLength(5);
    expect(r.body).toContain('data-next=""');
  });
});
