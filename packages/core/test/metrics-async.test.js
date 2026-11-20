import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createMetrics, ensureMetricsTableAsync } from '../src/admin/metrics.js';

const fresh = () => createSqliteAdapter({ file: ':memory:', walMode: false });

describe('hourly metrics over the asynchronous database', () => {
  it('flushes counters and gauges in one transaction; the sync and async readers agree', async () => {
    const db = fresh();
    await ensureMetricsTableAsync(db);
    const t = new Date('2026-03-01T10:30:00Z');
    const m = createMetrics(db, { now: () => new Date(t), synchronous: false });
    m.inc('http.requests', 3);
    m.inc('http.ms', 30);
    m.set('queue.len', 7);
    expect(await m.flushAsync()).toBe(3);
    expect(await m.flushAsync()).toBe(0);
    const s = await m.seriesAsync('http.requests', { hours: 3 });
    expect(s.map((p) => p.value)).toEqual([0, 0, 3]);
    expect(m.series('http.requests', { hours: 3 })).toEqual(s);
    const avg = await m.periodAverageAsync('http.ms', 'http.requests', '24h');
    expect(avg.at(-1).value).toBe(10);
    const last = await m.periodSeriesAsync('queue.len', '24h', { mode: 'last' });
    expect(last.at(-1).value).toBe(7);
    expect(last[0].value).toBeNull();
    m.inc('http.requests', 2);
    await m.flushAsync();
    expect((await m.seriesAsync('http.requests', { hours: 1 }))[0].value).toBe(5);
  });
  it('purges old buckets and keeps the counts when a flush fails', async () => {
    const db = fresh();
    await ensureMetricsTableAsync(db);
    let t = new Date('2026-03-01T10:00:00Z');
    const m = createMetrics(db, { now: () => new Date(t), retentionDays: 1, synchronous: false });
    m.inc('a', 1);
    await m.flushAsync();
    t = new Date('2026-03-05T10:00:00Z');
    expect(await m.purgeAsync()).toBe(1);
    db.exec('DROP TABLE metrics_hourly');
    m.inc('a', 4);
    let err;
    try { await m.flushAsync(); } catch (e) { err = e; }
    expect(err).toBeDefined();
    await ensureMetricsTableAsync(db);
    expect(await m.flushAsync()).toBe(1);
    expect((await m.seriesAsync('a', { hours: 1 }))[0].value).toBe(4);
    await m.closeAsync();
  });
});
