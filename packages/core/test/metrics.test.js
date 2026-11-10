import { describe, it, expect } from 'vitest';
import { createPrometheusMetrics, registerCoreGauges } from '../src/observability/index.js';
import { ObservabilityConfigSchema as Obs } from '../src/config/schema.js';

// A stand-in for the client package with the same shape (Registry, Counter, Histogram, Gauge).
function fakeClient() {
  class Registry {
    constructor() { this.items = []; this.contentType = 'text/plain; version=0.0.4'; }
    async metrics() {
      const out = [];
      for (const m of this.items) {
        if (m.collect) await m.collect.call(m);
        out.push(...m.lines());
      }
      return out.join('\n');
    }
  }
  const reg = (m, cfg) => { cfg.registers?.[0].items.push(m); m.name = cfg.name; m.collect = cfg.collect; return m; };
  class Counter { constructor(c) { this.v = new Map(); reg(this, c); } inc(l) { const k = JSON.stringify(l); this.v.set(k, (this.v.get(k) ?? 0) + 1); } lines() { return [...this.v].map(([k, n]) => `${this.name}${k} ${n}`); } }
  class Histogram { constructor(c) { this.n = 0; reg(this, c); } observe() { this.n++; } lines() { return [`${this.name}_count ${this.n}`]; } }
  class Gauge { constructor(c) { reg(this, c); } set(v) { this.val = v; } lines() { return this.val === undefined ? [] : [`${this.name} ${this.val}`]; } }
  return { Registry, Counter, Histogram, Gauge, collectDefaultMetrics: () => {} };
}
const make = (extra = {}) => createPrometheusMetrics({ importClient: async () => fakeClient(), ...extra });
function res() {
  const r = { code: 200, body: undefined, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; }, end() { return this; }, on(ev, cb) { this.fin = cb; } };
  return r;
}
const req = (ip, auth) => ({ headers: auth ? { authorization: auth } : {}, socket: { remoteAddress: ip } });

describe('prometheus metrics', () => {
  it('counts finished requests by route template and status class', async () => {
    const m = await make();
    const r = res();
    const rq = { method: 'get', route: { path: '/users/:id' }, baseUrl: '/api' };
    m.middleware()(rq, r, () => {});
    r.statusCode = 404;
    r.fin();
    const unmatched = res();
    m.middleware()({ method: 'POST' }, unmatched, () => {});
    unmatched.statusCode = 200;
    unmatched.fin();
    const text = await m.render();
    expect(text).toContain('das_http_requests_total{"method":"GET","route":"/api/users/:id","status":"4xx"} 1');
    expect(text).toContain('"route":"unmatched"');
    expect(text).toContain('das_http_request_duration_seconds_count 2');
  });

  it('answers 404 to anyone without the token or an allowed address', async () => {
    const m = await make();
    const h = m.handler({ token: 'secret-token-123456', allowIps: ['127.0.0.1'] });
    for (const q of [req('10.0.0.5'), req('10.0.0.5', 'Bearer wrong'), req('10.0.0.5', 'Basic secret-token-123456')]) {
      const r = res(); await h(q, r); expect(r.code).toBe(404); expect(r.body).toBeUndefined();
    }
    let r = res(); await h(req('10.0.0.5', 'Bearer secret-token-123456'), r);
    expect(r.code).toBe(200);
    expect(r.headers['Cache-Control']).toBe('no-store');
    r = res(); await h(req('127.0.0.1'), r);
    expect(r.code).toBe(200);
  });

  it('with no token set, only the allowed addresses can read, and an empty bearer never matches', async () => {
    const m = await make();
    const h = m.handler({});
    let r = res(); await h(req('192.168.1.2', 'Bearer '), r); expect(r.code).toBe(404);
    r = res(); await h(req('::1'), r); expect(r.code).toBe(200);
  });

  it('reads gauges at scrape time and survives a failing source', async () => {
    const m = await make();
    let age = 90;
    registerCoreGauges(m, { mailQueue: { stats: () => ({ pending: 3, failed: 1 }) }, lastBackupAt: () => new Date(Date.now() - age * 1000), now: () => Date.now() });
    m.addGauge({ name: 'broken', help: 'x', collect: () => { throw new Error('boom'); } });
    m.addGauge({ name: 'unknown', help: 'x', collect: () => null });
    const text = await m.render();
    expect(text).toContain('das_mail_queue_pending 3');
    expect(text).toContain('das_mail_queue_failed 1');
    expect(text).toMatch(/das_last_backup_age_seconds 9\d(\.\d+)?/);
    expect(text).not.toContain('das_broken');
    expect(text).not.toContain('das_unknown');
  });

  it('exports the security state: bans, open incidents, recent alerts, maintenance', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(':memory:');
    const db = { exec: (q) => raw.exec(q), get: (q, p = []) => raw.prepare(q).get(...p), all: (q, p = []) => raw.all?.(q, p) ?? raw.prepare(q).all(...p), run: (q, p = []) => raw.prepare(q).run(...p) };
    db.exec('CREATE TABLE security_bans (id INTEGER PRIMARY KEY, kind TEXT, value TEXT, created_at TEXT, expires_at TEXT, lifted_at TEXT)');
    db.exec('CREATE TABLE alerts (id INTEGER PRIMARY KEY, created_at TEXT)');
    const now = Date.now(); const iso = (ms) => new Date(ms).toISOString();
    db.run('INSERT INTO security_bans (kind, value, created_at, expires_at, lifted_at) VALUES (?,?,?,?,?)', ['ip', '1.1.1.1', iso(now), null, null]); // active
    db.run('INSERT INTO security_bans (kind, value, created_at, expires_at, lifted_at) VALUES (?,?,?,?,?)', ['ip', '2.2.2.2', iso(now), iso(now - 1000), null]); // expired
    db.run('INSERT INTO security_bans (kind, value, created_at, expires_at, lifted_at) VALUES (?,?,?,?,?)', ['ip', '3.3.3.3', iso(now), null, iso(now)]); // lifted
    db.run('INSERT INTO alerts (created_at) VALUES (?)', [iso(now - 3600000)]);
    db.run('INSERT INTO alerts (created_at) VALUES (?)', [iso(now - 3 * 86400000)]);
    const m = await make();
    let on = false;
    registerCoreGauges(m, { db, maintenance: { get: () => ({ enabled: on }) }, now: () => now });
    let text = await m.render();
    expect(text).toContain('das_bans_active 1');
    expect(text).toContain('das_alerts_24h 1');
    expect(text).toContain('das_maintenance_mode 0');
    expect(text).not.toContain('das_security_incidents_open'); // no such table here: the source is skipped, the scrape still works
    on = true;
    expect(await m.render()).toContain('das_maintenance_mode 1');
  });

  it('refuses unsafe names and reports a missing package with a clear code', async () => {
    const m = await make();
    expect(() => m.addGauge({ name: 'bad name{}', help: 'x', collect: () => 1 })).toThrow(/bad metric name/);
    await expect(createPrometheusMetrics({ prefix: 'a-b' })).rejects.toThrow(/prefix/);
    const err = await createPrometheusMetrics({ importClient: async () => { throw new Error('nope'); } }).catch((e) => e);
    expect(err.code).toBe('METRICS_PACKAGE_MISSING');
  });
});

describe('observability configuration', () => {
  it('is off by default and rejects a short token or a path with odd characters', () => {
    const base = Obs.prefault({}).parse({});
    expect(base.metrics).toMatchObject({ enabled: false, path: '/metrics', defaultMetrics: true });
    expect(Obs.safeParse({ metrics: { token: 'short' } }).success).toBe(false);
    expect(Obs.safeParse({ metrics: { path: '/m etrics' } }).success).toBe(false);
    expect(Obs.safeParse({ metrics: { enabled: true, token: 'a-long-enough-token-1' } }).success).toBe(true);
  });
});
