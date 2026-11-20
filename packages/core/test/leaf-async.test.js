import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createAnnouncement } from '../src/announcement/index.js';
import { createMaintenance } from '../src/maintenance/index.js';
import { registerCoreGauges } from '../src/observability/gauges.js';
import * as auth from '../src/auth/index.js';
import { queryAsync } from '../src/audit/index.js';

const fresh = () => createSqliteAdapter({ file: ':memory:', walMode: false });

describe('announcement over the asynchronous database', () => {
  it('sets, reads, expires, clears and renders; shares the row with the synchronous methods', async () => {
    const db = fresh();
    const clock = { t: Date.parse('2026-11-01T10:00:00Z') };
    const ann = createAnnouncement({ db, cacheMs: 0, now: () => clock.t });
    expect(await ann.activeAsync()).toBeNull();
    expect(await ann.bannerHtmlAsync()).toBe('');
    const s = await ann.setAsync({ message: 'Работы <b>в 22:00</b>', level: 'warning', until: '2026-11-01T12:00:00Z', by: 'root' });
    expect(s).toMatchObject({ enabled: true, level: 'warning', updatedBy: 'root' });
    expect(ann.get().message).toBe('Работы <b>в 22:00</b>'); // the synchronous reader sees it
    const html = await ann.bannerHtmlAsync('ru', { nonce: 'n1' });
    expect(html).toContain('adm-ann-warning');
    expect(html).toContain('&lt;b&gt;'); // escaped
    expect(html).toBe(ann.bannerHtml('ru', { nonce: 'n1' }));
    clock.t += 3 * 3600_000;
    expect(await ann.activeAsync()).toBeNull(); // past its end time
    await expect(ann.setAsync({ message: '' })).rejects.toThrow(/message is required/);
    await expect(ann.setAsync({ message: 'x', level: 'bad' })).rejects.toThrow(/level/);
    await expect(ann.setAsync({ message: 'x', until: 'nope' })).rejects.toThrow(/until/);
    await ann.setAsync({ message: 'again' });
    expect((await ann.clearAsync()).enabled).toBe(false);
    expect(await ann.activeAsync()).toBeNull();
  });

  it('audit line goes through the asynchronous log; a failing log never breaks the caller', async () => {
    const db = fresh();
    const ann = createAnnouncement({ db });
    await ann.auditedAsync({ user: { username: 'root' }, id: 'r1', ip: '1.1.1.1' }, 'announcement.set', { message: 'm', level: 'info' });
    const rows = await queryAsync(db, {});
    expect(rows[0]).toMatchObject({ action: 'announcement.set', actor: 'root', entity: 'announcement' });
    await createAnnouncement({ db: { async: { dialect: 'sqlite', exec: async () => { throw new Error('x'); }, get: async () => { throw new Error('x'); }, all: async () => { throw new Error('x'); }, run: async () => { throw new Error('x'); }, transaction: async () => { throw new Error('x'); } } } }).auditedAsync({}, 'a');
  });
});

describe('maintenance mode over the asynchronous database', () => {
  const run = (mw, req) => new Promise((resolve) => {
    const res = { headers: {}, locals: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b, headers: this.headers }); return this; }, type() { return this; }, send(b) { resolve({ code: this.code, html: b, headers: this.headers }); return this; } };
    mw(req, res, () => resolve({ next: true }));
  });
  it('switches on and off, lets administrators and the allowed paths through, answers 503 with Retry-After', async () => {
    const db = fresh();
    const clock = { t: Date.parse('2026-11-01T10:00:00Z') };
    const m = createMaintenance({ db, cacheMs: 0, now: () => clock.t });
    const mw = m.middlewareAsync({ vendorIdentity: { name: 'X', getLogo: () => null } });
    expect((await run(mw, { path: '/api/x', headers: {} })).next).toBe(true);
    const st = await m.enableAsync({ message: 'Обновление', until: '2026-11-01T10:10:00Z', by: 'root' });
    expect(st).toMatchObject({ enabled: true, startedBy: 'root' });
    expect(m.get().enabled).toBe(true); // synchronous reader agrees
    const r = await run(mw, { path: '/api/x', headers: { accept: 'application/json' }, user: { permissions: [] } });
    expect(r.code).toBe(503);
    expect(r.body).toMatchObject({ error: 'MAINTENANCE', message: 'Обновление' });
    expect(r.headers['Retry-After']).toBe('600');
    expect((await run(mw, { path: '/health', headers: {} })).next).toBe(true);
    expect((await run(mw, { path: '/api/x', headers: {}, user: { permissions: ['admin.access'] } })).next).toBe(true);
    await expect(m.enableAsync({ message: 'x'.repeat(501) })).rejects.toThrow(/at most/);
    await expect(m.enableAsync({ until: 'bad' })).rejects.toThrow(/until/);
    await m.disableAsync();
    expect((await run(mw, { path: '/api/x', headers: {} })).next).toBe(true);
    await m.enableAsync({});
    await m.auditedAsync({ user: { username: 'root' } }, 'maintenance.enable', {});
    expect((await queryAsync(db, {}))[0].action).toBe('maintenance.enable');
  });
  it('a failing read keeps the last known state instead of breaking requests', async () => {
    const m = createMaintenance({ db: { async: { dialect: 'sqlite', exec: async () => { throw new Error('down'); }, get: async () => { throw new Error('down'); }, all: async () => [], run: async () => ({}), transaction: async () => {} }, exec() { throw new Error('down'); }, get() { throw new Error('down'); } }, cacheMs: 0 });
    expect((await run(m.middlewareAsync({ vendorIdentity: { name: 'X', getLogo: () => null } }), { path: '/a', headers: {} })).next).toBe(true);
  });
});

describe('core gauges', () => {
  it('read through the asynchronous facade, and a missing table is skipped, not fatal', async () => {
    const db = fresh();
    await auth.ensureAuthTablesAsync(db);
    const gauges = {};
    registerCoreGauges({ addGauge: (g) => { gauges[g.name] = g.collect; } }, { db, now: () => Date.parse('2026-11-01T10:00:00Z') });
    expect(await gauges.sessions_active()).toBe(0);
    db.run('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, NULL, ?, ?)', ['h1:x', '2026-11-01T09:00:00Z', '2026-11-01T11:00:00Z']);
    expect(await gauges.sessions_active()).toBe(1);
    await expect(gauges.alerts_24h()).rejects.toThrow(/no such table/);
  });
});
