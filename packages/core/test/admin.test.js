import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createMetrics, svgBarChart, svgLineChart, createAdmin } from '../src/admin/index.js';

describe('metrics_hourly', () => {
  it('counts, flushes in batches and fills gaps with zeros', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    let t = Date.parse('2026-10-22T10:30:00Z');
    const m = createMetrics(db, { flushMs: 0, now: () => new Date(t) });
    m.inc('http.requests'); m.inc('http.requests', 2);
    t = Date.parse('2026-10-22T12:05:00Z');
    m.inc('http.requests', 4);
    const s = m.series('http.requests', { hours: 4 });
    expect(s.map((p) => p.bucket)).toEqual(['2026-10-22T09', '2026-10-22T10', '2026-10-22T11', '2026-10-22T12']);
    expect(s.map((p) => p.value)).toEqual([0, 3, 0, 4]);
    m.inc('http.requests', 1);
    m.flush();
    expect(m.series('http.requests', { hours: 1 })[0].value).toBe(5);
  });

  it('levels: the latest value in the hour wins, and a point without data stays empty', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    let t = Date.parse('2026-10-22T10:10:00Z');
    const m = createMetrics(db, { flushMs: 0, now: () => new Date(t) });
    m.set('sessions.active', 5); m.set('sessions.active', 7);
    t = Date.parse('2026-10-22T12:40:00Z');
    m.set('sessions.active', 3);
    const s = m.periodSeries('sessions.active', '24h', { mode: 'last' });
    expect(s.length).toBe(24);
    expect(s.find((p) => p.bucket === '2026-10-22T10').value).toBe(7);
    expect(s.find((p) => p.bucket === '2026-10-22T11').value).toBeNull();
    expect(s.find((p) => p.bucket === '2026-10-22T12').value).toBe(3);
  });

  it('periods group the hours: 7 days in steps of 6 hours, 30 days by the day; averages divide the sums', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    let t = Date.parse('2026-10-22T10:30:00Z');
    const m = createMetrics(db, { flushMs: 0, now: () => new Date(t) });
    m.inc('http.requests', 2); m.inc('http.ms', 30);
    t = Date.parse('2026-10-22T11:30:00Z');
    m.inc('http.requests', 2); m.inc('http.ms', 10);
    expect(m.periodSeries('http.requests', '7d').length).toBe(28);
    expect(m.periodSeries('http.requests', '30d').length).toBe(30);
    expect(m.periodSeries('http.requests', '30d').reduce((a, p) => a + p.value, 0)).toBe(4);
    const avg = m.periodAverage('http.ms', 'http.requests', '30d');
    expect(avg.filter((p) => p.value !== null).map((p) => p.value)).toEqual([10]);
    expect(m.periodSeries('http.requests', 'nonsense').length).toBe(24);
  });

  it('the middleware also records the time spent on a request', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    const m = createMetrics(db, { flushMs: 0 });
    let fin;
    m.middleware()({}, { on: (e, cb) => { fin = cb; }, statusCode: 404 }, () => {});
    fin();
    m.flush();
    expect(db.get(`SELECT value FROM metrics_hourly WHERE name = 'http.4xx'`).value).toBe(1);
    expect(db.get(`SELECT COUNT(*) AS n FROM metrics_hourly WHERE name = 'http.ms'`).n).toBe(1);
  });

  it('ignores bad names and purges old buckets', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    let t = Date.parse('2026-01-01T00:00:00Z');
    const m = createMetrics(db, { flushMs: 0, retentionDays: 10, now: () => new Date(t) });
    m.inc('bad name;'); m.inc('ok'); m.flush();
    expect(db.get('SELECT COUNT(*) AS n FROM metrics_hourly').n).toBe(1);
    t = Date.parse('2026-02-01T00:00:00Z');
    expect(m.purge()).toBe(1);
  });

  it('middleware counts finished requests by class', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    const m = createMetrics(db, { flushMs: 0 });
    for (const code of [200, 404, 500]) {
      const handlers = {};
      m.middleware()({}, { statusCode: code, on: (e, f) => { handlers[e] = f; } }, () => {});
      handlers.finish();
    }
    const last = (n) => m.series(n, { hours: 1 })[0].value;
    expect(last('http.requests')).toBe(3);
    expect(last('http.4xx')).toBe(1);
    expect(last('http.5xx')).toBe(1);
  });
});

describe('svg charts', () => {
  it('draws escaped, accessible bars and a line', () => {
    const pts = [{ label: '<b>', value: 3 }, { label: '01:00', value: 0 }, { label: '02:00', value: 7 }];
    const bar = svgBarChart(pts, { title: 'T"1' });
    expect(bar).toContain('role="img"');
    expect(bar).toContain('&lt;b&gt;');
    expect(bar).not.toContain('<b>');
    expect(bar).toContain('T&quot;1');
    expect((bar.match(/<rect x=/g) ?? []).length).toBe(3); // the bars; the hover columns are counted below
    // every point has a hover target that shows its value (a whole-height column for bars, a large circle for lines)
    expect((bar.match(/class="adm-hit"/g) ?? []).length).toBe(pts.length);
    expect(svgLineChart(pts, { title: 'L' })).toContain('class="adm-hit"');
    expect(svgLineChart(pts, { title: 'L' })).toContain('<path d="M');
    expect(svgBarChart([], { title: 'empty' })).toContain('<svg');
  });
});

describe('admin guard', () => {
  function fakeApp() {
    const routes = [];
    return { routes, get: (path, ...h) => routes.push({ path, h }), post: () => {} };
  }
  const requirePermission = (perm) => (req, res, next) => {
    if (!req.user) return res.status(401).end();
    if (!(req.user.permissions ?? []).includes(perm)) return res.status(403).end();
    next();
  };
  const requireAuth = () => (req, res, next) => (req.user ? next() : res.status(401).end());

  function run(chain, req) {
    const res = { code: 200, body: '', set() { return this; }, type() { return this; }, status(c) { this.code = c; return this; }, end() { return this; }, send(b) { this.body = b; return this; }, locals: {} };
    let i = 0;
    const next = () => { const h = chain[i++]; if (h) h(req, res, next); };
    next();
    return res;
  }

  it('GET /admin needs login and admin.access, then renders the overview', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    const app = fakeApp();
    createAdmin({ db, metrics: createMetrics(db, { flushMs: 0 }) }).mount(app, { requireAuth, requirePermission });
    const route = app.routes.find((r) => r.path === '/admin');
    expect(run(route.h, {}).code).toBe(401);
    expect(run(route.h, { user: { permissions: ['read:basic'] } }).code).toBe(403);
    const ok = run(route.h, { query: {}, user: { username: 'ann', permissions: ['admin.access'] } });
    expect(ok.code).toBe(200);
    expect(ok.body).toContain('Обзор');
    expect(ok.body).toContain('<svg');
    expect(ok.body).toContain('ann');
    // period tabs and the wider set of charts
    expect(ok.body).toContain('href="/admin?period=7d"');
    expect((ok.body.match(/<svg/g) ?? []).length).toBeGreaterThanOrEqual(6);
    const week = run(route.h, { query: { period: '7d' }, user: { username: 'ann', permissions: ['admin.access'] } });
    expect(week.body).toMatch(/href="\/admin\?period=7d"[^>]*aria-current="page"/);
    expect(run(route.h, { query: { period: '<script>' }, user: { username: 'ann', permissions: ['admin.access'] } }).body).toMatch(/href="\/admin\?period=24h"[^>]*aria-current="page"/);
  });
});
