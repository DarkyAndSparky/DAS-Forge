import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createBans, parseDuration } from '../src/security/index.js';
import { createAdmin, createMetrics } from '../src/admin/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { log, query, verifyChain } from '../src/audit/index.js';

function setup() {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  let t = Date.parse('2026-10-22T10:00:00Z');
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  return { db, clock, bans: createBans(db, { cacheMs: 0, now: clock.now }) };
}

describe('security_bans', () => {
  it('bans an ip (IPv4-mapped is the same client), lifts it, keeps history and audits both', () => {
    const { db, bans } = setup();
    const r = bans.ban({ kind: 'ip', value: '::ffff:10.0.0.5', reason: 'scan', by: 'ann' });
    expect(r.value).toBe('10.0.0.5');
    expect(bans.ban({ kind: 'ip', value: '10.0.0.5' }).already).toBe(true);
    expect(bans.check({ ip: '::ffff:10.0.0.5' })?.reason).toBe('scan');
    expect(bans.check({ ip: '10.0.0.6' })).toBe(null);
    expect(bans.lift({ kind: 'ip', value: '10.0.0.5', by: 'ann' })).toBe(1);
    expect(bans.check({ ip: '10.0.0.5' })).toBe(null);
    expect(bans.list({ active: true }).length).toBe(0);
    expect(bans.list({ active: false }).length).toBe(1);
    const actions = query(db, {}).map((e) => e.action);
    expect(actions.includes('security.ban')).toBe(true);
    expect(actions.includes('security.unban')).toBe(true);
    expect(verifyChain(db).ok).toBe(true);
  });

  it('expires a timed ban and rejects bad values', () => {
    const { bans, clock } = setup();
    bans.ban({ kind: 'user', value: 'mallory', durationMs: parseDuration('1h') });
    expect(bans.check({ username: 'mallory' }) !== null).toBe(true);
    clock.advance(3_600_001);
    expect(bans.check({ username: 'mallory' })).toBe(null);
    expect(() => bans.ban({ kind: 'ip', value: 'not-an-ip' })).toThrow(/not an IP/);
    expect(() => bans.ban({ kind: 'x', value: 'a' })).toThrow(/unknown kind/);
    expect(() => parseDuration('soon')).toThrow(/invalid duration/);
    expect(parseDuration('7d')).toBe(7 * 86400_000);
    expect(parseDuration('')).toBe(null);
  });

  it('banning a user ends their sessions', () => {
    const { db, bans } = setup();
    db.run(`INSERT INTO users (username, password_hash) VALUES ('bob', 'x')`);
    const id = db.get(`SELECT id FROM users WHERE username='bob'`).id;
    db.run(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('h1', ?, 'a', 'z')`, [id]);
    expect(bans.ban({ kind: 'user', value: 'bob' }).sessionsEnded).toBe(1);
    expect(db.get('SELECT COUNT(*) AS n FROM sessions').n).toBe(0);
  });

  it('middleware blocks banned ip and banned logged-in user', () => {
    const { bans } = setup();
    bans.ban({ kind: 'ip', value: '10.1.1.1' });
    bans.ban({ kind: 'user', value: 'eve' });
    const run = (req) => {
      const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, type() { return this; }, send(b) { this.body = b; return this; } };
      let passed = false;
      bans.middleware()({ headers: {}, path: '/x', ...req }, res, () => { passed = true; });
      return { res, passed };
    };
    expect(run({ ip: '10.1.1.1' }).res.code).toBe(403);
    expect(run({ ip: '10.1.1.1' }).res.body.error).toBe('BANNED');
    expect(run({ ip: '10.9.9.9', user: { username: 'eve' } }).passed).toBe(false);
    expect(run({ ip: '10.9.9.9', user: { username: 'ann' } }).passed).toBe(true);
  });
});

describe('admin sections', () => {
  function build() {
    const { db, bans } = setup();
    const routes = {};
    const app = {
      get: (p, ...h) => { routes[`GET ${p}`] = h; },
      post: (p, ...h) => { routes[`POST ${p}`] = h; },
    };
    const requireAuth = () => (req, res, next) => (req.user ? next() : res.status(401).end());
    const requirePermission = (perm) => (req, res, next) => ((req.user.permissions ?? []).includes(perm) ? next() : res.status(403).end());
    createAdmin({ db, bans, metrics: createMetrics(db, { flushMs: 0 }) }).mount(app, { requireAuth, requirePermission });
    return { db, bans, routes };
  }
  const admin = { username: 'root', permissions: ['admin.access'] };
  function call(chain, req) {
    return new Promise((resolve) => {
      const done = (res) => () => { resolve(res); return res; };
      const res = { code: 200, body: '', headers: {}, locals: {}, set(k, v) { if (typeof k === 'string') this.headers[k] = v; return this; }, type() { return this; }, status(c) { this.code = c; return this; } };
      res.write = (c) => { res.body += String(c); return true; };
      res.end = (c) => { if (c) res.body += String(c); resolve(res); return res; };
      res.send = (b2) => { res.body = b2; resolve(res); return res; };
      res.redirect = (c, loc) => { res.code = c; res.location = loc; resolve(res); return res; };
      let i = 0;
      const next = () => { const h = chain[i++]; if (h) Promise.resolve(h(req, res, next)).catch((e) => { res.body = String(e); resolve(res); }); };
      next();
    });
  }

  it('audit and security pages need the permission; the audit table escapes and paginates', async () => {
    const { db, routes } = build();
    expect((await call(routes['GET /admin/audit'], { user: { permissions: [] }, query: {} })).code).toBe(403);
    log(db, { action: '<script>x', actor: 'a"b' });
    const r = await call(routes['GET /admin/audit'], { user: admin, query: {} });
    expect(r.body).toContain('&lt;script&gt;x');
    expect(r.body).not.toContain('<script>x');
    const v = await call(routes['GET /admin/audit'], { user: admin, query: { verify: '1' } });
    expect(v.body).toContain('Цепочка целостна');
  });

  it('csv export neutralises formulas and is itself audited', async () => {
    const { db, routes } = build();
    log(db, { action: '=HYPERLINK("x")', actor: 'zed' });
    const r = await call(routes['GET /admin/audit.csv'], { user: admin, query: {} });
    expect(r.body).toContain(`"'=HYPERLINK(""x"")"`);
    expect(query(db, { action: 'admin.audit.export' }).length).toBe(1);
  });

  it('json export and the sign-in view only cover auth.login* events', async () => {
    const { db, routes } = build();
    log(db, { action: 'auth.login', actor: 'ann' });
    log(db, { action: 'auth.login.totp', actor: 'ann', result: 'failure' });
    log(db, { action: 'asset.create', actor: 'ann' });
    const j = await call(routes['GET /admin/audit.json'], { user: admin, query: { view: 'logins' } });
    const rows = JSON.parse(j.body);
    expect(rows.map((e) => e.action).sort()).toEqual(['auth.login', 'auth.login.totp']);
    const all = JSON.parse((await call(routes['GET /admin/audit.json'], { user: admin, query: {} })).body);
    expect(all.some((e) => e.action === 'asset.create')).toBe(true);
    const html = await call(routes['GET /admin/audit'], { user: admin, query: { view: 'logins' } });
    expect(html.body).toContain('auth.login.totp');
    expect(html.body).not.toContain('asset.create');
    expect(html.body).toContain('audit.json?');
  });

  it('ban/lift via the security forms, with self-lockout refused', async () => {
    const { bans, routes } = build();
    const post = (chain, body, extra = {}) => call(chain, { user: admin, body, query: {}, params: {}, ip: '10.0.0.1', ...extra });
    let r = await post(routes['POST /admin/security/bans'], { kind: 'ip', value: '10.2.2.2', reason: 'x', duration: '1h' });
    expect(r.location).toBe('/admin/security?msg=ok');
    expect(bans.check({ ip: '10.2.2.2' }) !== null).toBe(true);
    r = await post(routes['POST /admin/security/bans'], { kind: 'user', value: 'root' });
    expect(r.location).toBe('/admin/security?msg=bad');
    r = await post(routes['POST /admin/security/bans'], { kind: 'ip', value: '10.0.0.1' });
    expect(r.location).toBe('/admin/security?msg=bad');
    const id = bans.list()[0].id;
    r = await post(routes['POST /admin/security/bans/:id/lift'], {}, { params: { id: String(id) } });
    expect(r.location).toBe('/admin/security?msg=ok');
    expect(bans.check({ ip: '10.2.2.2' })).toBe(null);
    const page = await call(routes['GET /admin/security'], { user: admin, query: {} });
    expect(page.body).toContain('Баны');
  });

  it('revokes a session by its stored id', async () => {
    const { db, routes } = build();
    db.run(`INSERT INTO users (username, password_hash) VALUES ('bob', 'x')`);
    const uid = db.get(`SELECT id FROM users`).id;
    db.run(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('abc', ?, 'a', 'z')`, [uid]);
    const r = await call(routes['POST /admin/security/sessions/:id/revoke'], { user: admin, params: { id: 'abc' }, query: {} });
    expect(r.location).toBe('/admin/security?msg=ok');
    expect(db.get('SELECT COUNT(*) AS n FROM sessions').n).toBe(0);
  });
});

describe('CLI: ban add / lift / list', () => {
  it('works end to end and rejects bad input', async () => {
    const { createCli, registerBanCommands } = await import('../src/cli/index.js');
    const { db } = setup();
    const bans = createBans(db, { cacheMs: 0 });
    const out = [];
    const orig = [console.log, console.error];
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => out.push(a.join(' '));
    try {
      const run = (...argv) => { const cli = createCli(); registerBanCommands(cli, { bans }); return cli.run(argv); };
      expect(await run('ban', 'add', 'ip', '10.3.3.3', '--reason', 'abuse', '--duration', '2h')).toBe(0);
      expect(bans.check({ ip: '10.3.3.3' }) !== null).toBe(true);
      expect(await run('ban', 'list', '--json')).toBe(0);
      expect(out.some((l) => l.includes('10.3.3.3'))).toBe(true);
      expect(await run('ban', 'add', 'ip', 'nope')).not.toBe(0);
      expect(await run('ban', 'lift', 'ip', '10.3.3.3')).toBe(0);
      expect(bans.check({ ip: '10.3.3.3' })).toBe(null);
      expect(await run('ban', 'add')).not.toBe(0);
    } finally {
      [console.log, console.error] = orig;
    }
  });
});
