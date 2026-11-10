import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createAdmin } from '../src/admin/index.js';
import { flattenConfig } from '../src/admin/sections-system.js';
import { createEmailQueue } from '../src/email/queue.js';
import { query } from '../src/audit/index.js';

const admin = { id: 1, username: 'root', permissions: ['admin.access'] };
function build(opts = {}) {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const requireAuth = () => (req, res, next) => (req.user ? next() : res.status(401).end());
  const requirePermission = (perm) => (req, res, next) => ((req.user.permissions ?? []).includes(perm) ? next() : res.status(403).end());
  createAdmin({ db, ...opts }).mount(app, { requireAuth, requirePermission });
  return { db, routes };
}
function call(chain, req) {
  return new Promise((resolve) => {
    req.on ??= function (ev, cb) { if (ev === 'end') cb(); return this; };
    const res = { code: 200, body: '', locals: {}, set() { return this; }, type() { return this; }, status(c) { this.code = c; return this; } };
    res.end = () => { resolve(res); return res; };
    res.send = (b) => { res.body = b; resolve(res); return res; };
    res.redirect = (c, loc) => { res.code = c; res.location = loc; resolve(res); return res; };
    let i = 0;
    const next = () => { const h = chain[i++]; if (h) Promise.resolve(h(req, res, next)).catch((e) => { res.body = String(e); resolve(res); }); };
    next();
  });
}

describe('tasks section', () => {
  const jobs = [
    { name: 'backup', expression: '0 3 * * *', running: false, lastRunAt: new Date('2026-10-27T03:00:00Z'), lastError: null },
    { name: 'sync<x>', expression: '*/5 * * * *', running: false, lastRunAt: null, lastError: 'boom' },
  ];
  const ran = [];
  const scheduler = { listJobs: () => jobs, runNow: async (n) => { ran.push(n); if (n === 'sync<x>') throw new Error('boom'); } };

  it('lists the jobs, escapes names, shows state and warns on the overview', async () => {
    const { routes } = build({ scheduler });
    const page = await call(routes['GET /admin/tasks'], { user: admin, query: {} });
    expect(page.body).toContain('<strong>backup</strong>');
    expect(page.body).toContain('sync&lt;x&gt;');
    expect(page.body).not.toContain('sync<x>');
    expect(page.body).toContain('0 3 * * *');
    expect(page.body).toContain('boom');
    const ov = await call(routes['GET /admin'], { user: admin, query: {} });
    expect(ov.body).toContain('/admin/tasks');
    expect(ov.body).toContain('sync&lt;x&gt;');
  });

  it('runs a task now, audits it, and answers a failure and an unknown name without a stack', async () => {
    const { db, routes } = build({ scheduler });
    const ok = await call(routes['POST /admin/tasks/:name/run'], { user: admin, params: { name: 'backup' }, query: {} });
    expect(ok.location).toBe('/admin/tasks?msg=ok');
    const bad = await call(routes['POST /admin/tasks/:name/run'], { user: admin, params: { name: 'sync<x>' }, query: {} });
    expect(bad.location).toContain('msg=bad');
    const unknown = await call(routes['POST /admin/tasks/:name/run'], { user: admin, params: { name: 'nope' }, query: {} });
    expect(unknown.location).toContain('e=UNKNOWN');
    expect(ran).toEqual(['backup', 'sync<x>']);
    const entries = query(db, { action: 'admin.task.run' });
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.result).sort()).toEqual(['failure', 'success']);
  });

  it('says what to do when there are no tasks', async () => {
    const { routes } = build({ scheduler: { listJobs: () => [], runNow: async () => {} } });
    expect((await call(routes['GET /admin/tasks'], { user: admin, query: {} })).body).toContain('scheduler.registerJob');
  });
});

describe('mail section', () => {
  it('shows counters and the newest rows with shortened addresses and no bodies', async () => {
    const db0 = createSqliteAdapter({ file: ':memory:' });
    const queue = createEmailQueue({ db: db0, send: async () => {} });
    queue.enqueue({ to: ['anna.ivanova@example.com'], subject: 'secret subject', text: 'secret body' }, { scenario: 'welcome' });
    const { routes } = build({ mail: { queue, service: { enabled: true } } });
    const page = await call(routes['GET /admin/mail'], { user: admin, query: {} });
    expect(page.body).toContain('welcome');
    expect(page.body).not.toContain('anna.ivanova@example.com');
    expect(page.body).not.toContain('secret body');
    expect(page.body).not.toContain('secret subject');
    expect(page.body).toContain('@');
  });

  it('cancels one waiting letter and clears finished ones, with audit; content is erased', async () => {
    const db0 = createSqliteAdapter({ file: ':memory:' });
    const queue = createEmailQueue({ db: db0, send: async () => {} });
    queue.enqueue({ to: ['a@example.com'], subject: 's', text: 'secret body' }, { scenario: 'one' });
    queue.enqueue({ to: ['b@example.com'], subject: 's', text: 'secret body' }, { scenario: 'two' });
    const { db, routes } = build({ mail: { queue, service: { enabled: true } } });
    const id = queue.list()[0].id;
    const page = await call(routes['GET /admin/mail'], { user: admin, query: {} });
    expect(page.body).toContain('/admin/mail/cancel');
    const r = await call(routes['POST /admin/mail/cancel'], { user: admin, query: {}, body: { id: String(id) } });
    expect(r.location).toBe('/admin/mail?msg=cancelled');
    expect(queue.list().find((x) => x.id === id)).toMatchObject({ status: 'failed', lastError: 'CANCELLED' });
    expect(db0.get('SELECT payload FROM email_queue WHERE id = ?', [id]).payload).toBe(null);
    // the second cancel of the same row, and a made-up id, do nothing
    expect((await call(routes['POST /admin/mail/cancel'], { user: admin, query: {}, body: { id: String(id) } })).location).toBe('/admin/mail');
    expect((await call(routes['POST /admin/mail/cancel'], { user: admin, query: {}, body: { id: 'x' } })).location).toBe('/admin/mail');
    expect(query(db, { action: 'admin.mail.cancel' }).length).toBe(1);
    const purge = await call(routes['POST /admin/mail/purge'], { user: admin, query: {} });
    expect(purge.location).toMatch(/^\/admin\/mail\?msg=purged&n=\d+$/);
    expect(query(db, { action: 'admin.mail.purge' }).length).toBe(1);
  });

  it('warns on the overview when mails failed, and says when sending is off', async () => {
    const queue = { stats: () => ({ pending: 0, sending: 0, sent: 3, failed: 2 }), list: () => [] };
    const { routes } = build({ mail: { queue, service: { enabled: false } } });
    expect((await call(routes['GET /admin'], { user: admin, query: {} })).body).toContain('/admin/mail');
    const page = await call(routes['GET /admin/mail'], { user: admin, query: {} });
    expect(page.body).toContain('email.enabled');
    expect(page.body).toContain('Писем в очереди нет.');
  });
});

describe('environment variables on the configuration page', () => {
  it('describeEnv: origin of each honoured variable, typos with a suggestion, never a value', async () => {
    const { describeEnv } = await import('../src/config/env.js');
    const r = describeEnv({ DAS_PORT: '9000', DAS_SESSION_SECRET_FILE: '/run/secrets/s', DAS_HOST: 'h', DAS_HOST_FILE: '/x', DAS_SESION_SECRET: 'top-secret-zzz', DAS_TOTALLY_OTHER: '1', PATH: '/bin' });
    const by = Object.fromEntries(r.known.map((k) => [k.name, k]));
    expect(by.DAS_PORT.source).toBe('env');
    expect(by.DAS_SESSION_SECRET.source).toBe('file');
    expect(by.DAS_HOST).toMatchObject({ source: 'env', note: 'both' });
    expect(by.DAS_ENV.source).toBe('unset');
    expect(r.unknown).toEqual([{ name: 'DAS_SESION_SECRET', didYouMean: 'DAS_SESSION_SECRET' }, { name: 'DAS_TOTALLY_OTHER', didYouMean: null }]);
    expect(JSON.stringify(r)).not.toContain('top-secret-zzz');
  });

  it('the page lists them and shows a typo, with no values', async () => {
    process.env.DAS_SESION_SECRET = 'top-secret-zzz';
    try {
      const { routes } = build({ config: { env: 'production' } });
      const page = await call(routes['GET /admin/config'], { user: admin, query: {} });
      expect(page.body).toContain('DAS_SESSION_SECRET');
      expect(page.body).toContain('DAS_SESION_SECRET');
      expect(page.body).toContain('возможно, имелась в виду');
      expect(page.body).not.toContain('top-secret-zzz');
    } finally { delete process.env.DAS_SESION_SECRET; }
  });
});

describe('configuration section', () => {
  const config = { env: 'production', server: { port: 9002 }, auth: { sessionSecret: 'super-secret-value-0123456789', totpEncryptionKey: 'env:TOTP_KEY', passwordPolicy: { minLength: 10 } }, email: { smtp: { host: 'mx', pass: 'p4ss', port: 587 } }, ui: { modules: [] } };

  it('hides secrets, keeps env references and plain numbers, and filters by name', () => {
    const flat = Object.fromEntries(flattenConfig(config));
    expect(flat['auth.sessionSecret']).toBe(null);
    expect(flat['auth.totpEncryptionKey']).toBe('env:TOTP_KEY');
    expect(flat['email.smtp.pass']).toBe(null);
    expect(flat['email.smtp.port']).toBe(587);
    expect(flat['auth.passwordPolicy.minLength']).toBe(10);
  });

  it('never prints a secret in the page', async () => {
    const { routes } = build({ config });
    const page = await call(routes['GET /admin/config'], { user: admin, query: {} });
    expect(page.body).not.toContain('super-secret-value');
    expect(page.body).not.toContain('p4ss');
    expect(page.body).toContain('env:TOTP_KEY');
    expect(page.body).toContain('auth.sessionSecret');
    const filtered = await call(routes['GET /admin/config'], { user: admin, query: { q: 'smtp' } });
    expect(filtered.body).toContain('email.smtp.host');
    expect(filtered.body).not.toContain('server.port');
  });

  it('with the loader report it shows where each value comes from, and can show only what was set', async () => {
    const { routes } = build({ config, configSources: { fileConfig: { server: { port: 9002 } }, envPaths: ['email.smtp.host'] } });
    const page = await call(routes['GET /admin/config'], { user: admin, query: {} });
    expect(page.body).toContain('Источник');
    const row = (body, key) => body.split('<tr>').find((r) => r.includes(`<td>${key}</td>`)) ?? '';
    expect(row(page.body, 'server.port')).toContain('файл настроек');
    expect(row(page.body, 'email.smtp.host')).toContain('переменная окружения');
    expect(row(page.body, 'ui.modules')).toContain('умолчание');
    expect(page.body).toContain('name="changed"');
    const only = await call(routes['GET /admin/config'], { user: admin, query: { changed: '1' } });
    expect(only.body).toContain('server.port');
    expect(only.body).not.toContain('<td>ui.modules</td>');
    expect(only.body).not.toContain('super-secret-value');
  });

  it('without the report the page stays as before: two columns, no source', async () => {
    const { routes } = build({ config });
    const page = await call(routes['GET /admin/config'], { user: admin, query: {} });
    expect(page.body).not.toContain('Источник');
    expect(page.body).not.toContain('name="changed"');
  });

  it('the sections exist only when their option is given', () => {
    const { routes } = build();
    for (const p of ['tasks', 'mail', 'config']) expect(routes[`GET /admin/${p}`]).toBeUndefined();
  });
});
