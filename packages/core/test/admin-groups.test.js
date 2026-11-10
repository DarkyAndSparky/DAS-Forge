import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createAdmin } from '../src/admin/index.js';
import { createMaintenance } from '../src/maintenance/index.js';
import { createAnnouncement } from '../src/announcement/index.js';
import { createIncidentRegister } from '../src/privacy/incidents.js';

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
function build(opts = {}) {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  const routes = {};
  const adm = createAdmin({ db, incidents: createIncidentRegister(db), maintenance: createMaintenance({ db }), announcement: createAnnouncement({ db }), ...opts });
  adm.mount({ get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } }, { requireAuth: () => (r, s, n) => n(), requirePermission: () => (r, s, n) => n() });
  const get = async (p) => (await call(routes[`GET ${p}`], { user: admin, query: {}, headers: {} })).body;
  return { routes, get, db };
}
const navOf = (html) => html.match(/<nav class="adm-nav"[\s\S]*?<\/nav>/)[0];
const order = (html, ...marks) => marks.map((m) => html.indexOf(m));

describe('the admin menu is grouped', () => {
  it('shows Users first, then Security, System, Operation (when not split) and Other, each as a group title', async () => {
    const { get } = build({ config: { app: { name: 'x' } } });
    const nav = navOf(await get('/admin'));
    for (const g of ['Безопасность', 'Система', 'Обслуживание']) expect(nav).toContain(`<div class="adm-nav-group">${g}</div>`);
    const [users, sec, audit, ops] = order(nav, 'Пользователи', '>Безопасность<', 'Аудит', 'Режим обслуживания');
    expect(users > 0 && users < sec && sec < audit && audit < ops).toBe(true);
    expect(nav).toContain('href="/admin/maintenance"'); // everything stays under /admin by default
  });
});

describe('controlPath splits application operation off the administration area', () => {
  it('mounts the operation sections under /control with their own menu, and leaves /admin without them', async () => {
    const { routes, get } = build({ controlPath: '/control' });
    expect(routes['GET /control']).toBeTruthy();
    expect(routes['GET /control/maintenance']).toBeTruthy();
    expect(routes['GET /control/announcement']).toBeTruthy();
    expect(routes['GET /admin/maintenance']).toBe(undefined);
    expect(routes['GET /admin/audit']).toBeTruthy();
    const adminNav = navOf(await get('/admin'));
    expect(adminNav).not.toContain('href="/admin/maintenance"');
    expect(adminNav).toContain('href="/control"'); // a way over to the control area
    const control = await get('/control');
    const cnav = navOf(control);
    expect(cnav).toContain('href="/control/maintenance"');
    expect(cnav).not.toContain('href="/admin/audit"');
    expect(cnav).toContain('href="/admin"'); // and back
    expect(control).toContain('Управление приложением'); // the badge
    const section = await get('/control/maintenance');
    expect(section).toContain('action="/control/maintenance');
  });

  it('keeps the maintenance alert on the administration overview, pointing into the control area', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    ensureAuthTables(db);
    const maintenance = createMaintenance({ db });
    maintenance.enable({ message: 'x' });
    const routes = {};
    createAdmin({ db, maintenance, controlPath: '/control' }).mount({ get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: () => {} }, { requireAuth: () => (r, s, n) => n(), requirePermission: () => (r, s, n) => n() });
    const html = (await call(routes['GET /admin'], { user: admin, query: {}, headers: {} })).body;
    expect(maintenance.get().enabled).toBe(true);
    expect(html).toContain('href="/control/maintenance"');
  });
});

describe('searching the sections', () => {
  const q = (get, text, lang = 'ru') => get(`/admin/search?q=${encodeURIComponent(text)}&lang=${lang}`);
  function buildQ(opts) {
    const db = createSqliteAdapter({ file: ':memory:' });
    ensureAuthTables(db);
    const routes = {};
    createAdmin({ db, incidents: createIncidentRegister(db), maintenance: createMaintenance({ db }), announcement: createAnnouncement({ db }), config: { a: 1 }, ...opts })
      .mount({ get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: () => {} }, { requireAuth: () => (r, s, n) => n(), requirePermission: () => (r, s, n) => n() });
    return async (url) => {
      const [path, qs] = url.split('?');
      const query = Object.fromEntries(new URLSearchParams(qs));
      return (await call(routes[`GET ${path}`], { user: admin, query, headers: {} })).body;
    };
  }

  it('finds a section by its name or by a word a person would look for, in both languages', async () => {
    const get = buildQ({});
    expect(await q(get, 'утечка')).toContain('<a class="adm-card" href="/admin/incidents"');
    expect(await q(get, 'настройки')).toContain('<a class="adm-card" href="/admin/config"');
    expect(await q(get, '503')).toContain('<a class="adm-card" href="/admin/maintenance"');
    expect(await q(get, 'ПОЛЬЗОВАТЕЛИ')).toContain('<a class="adm-card" href="/admin/users"'); // case does not matter
    expect(await q(get, 'breach', 'en')).toContain('<a class="adm-card" href="/admin/incidents"');
    expect(await q(get, 'утечка настройки')).not.toContain('<a class="adm-card" href="/admin/incidents"'); // every word has to match
  });

  it('says so when nothing matches, hints on an empty query, and escapes what was typed', async () => {
    const get = buildQ({});
    expect(await q(get, 'ничегонет')).toContain('Ничего не найдено');
    expect(await q(get, '')).toContain('Введите название раздела');
    const html = await q(get, '"><script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('searches the control area too, and every admin page has the search box', async () => {
    const get = buildQ({ controlPath: '/control' });
    expect(await q(get, 'режим')).toContain('<a class="adm-card" href="/control/maintenance"');
    expect(await get('/admin')).toContain('<form class="adm-search" role="search" action="/admin/search"');
    expect(await get('/control')).toContain('action="/admin/search"');
  });
});

describe('limits on the overview', () => {
  it('shows nothing extra without limits', async () => {
    const { get } = build({});
    const html = await get('/admin');
    expect(html).not.toContain('class="adm-bar');
  });
  it('shows "of limit" with a bar, and amber from 80 %', async () => {
    const { get } = build({ limits: { users: { max: 100 } } });
    const html = await get('/admin');
    expect(html).toContain('class="adm-bar ok"');
    expect(html).toContain('из 100');
    expect(html).not.toContain('<div class="adm-card" role="alert"');
  });
  it('turns red with a notice when the limit is reached, amber when close', async () => {
    const a = build({ limits: { sessions: { max: 1 } } });
    a.db.run("INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES ('a', NULL, datetime('now'), datetime('now','+1 day'), datetime('now'))");
    const html = await a.get('/admin');
    expect(html).toContain('class="adm-bar over"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Лимит превышен');
  });
});

describe('system tiles', () => {
  it('show the process PID and more parameters; migrations only while some are pending', async () => {
    const a = build({ migrations: () => [{ applied: true }, { applied: true }] });
    const html = await a.get('/admin');
    expect(html).toContain(String(process.pid));
    expect(html).toContain('PID процесса');
    expect(html).toContain('Свободно ОЗУ');
    expect(html).not.toContain('Миграции');
    const b = build({ migrations: () => [{ applied: true }, { applied: false }] });
    expect(await b.get('/admin')).toContain('Миграции');
  });
});
