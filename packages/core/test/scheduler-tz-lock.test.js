import { describe, it, expect } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { getNextRun } from '../src/scheduler/cron-parse.js';
import { createScheduler } from '../src/scheduler/scheduler.js';
import { acquireFileLock } from '../src/scheduler/file-lock.js';

const tick = () => new Promise((r) => setTimeout(r, 30));

describe('cron time zones (B15)', () => {
  it('honours an IANA zone, incl. half-hour offsets', () => {
    expect(getNextRun('0 3 * * *', new Date('2026-10-15T00:00:00Z'), { timezone: 'Asia/Yekaterinburg' }).toISOString()).toBe('2026-10-15T22:00:00.000Z');
    expect(getNextRun('*/15 * * * *', new Date('2026-10-15T10:07:00Z'), { timezone: 'Asia/Kolkata' }).toISOString()).toBe('2026-10-15T10:15:00.000Z');
  });
  it('skips a nonexistent local time on the DST spring-forward day', () => {
    expect(getNextRun('30 2 * * *', new Date('2026-03-07T12:00:00Z'), { timezone: 'America/New_York' }).toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });
  it('rejects an unknown zone', () => {
    expect(() => getNextRun('* * * * *', new Date(), { timezone: 'Nope/Zone' })).toThrow();
  });
});

describe('file lock (B15)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-'));
  const f = path.join(dir, 'a.lock');
  it('is exclusive, releasable and takes over stale/dead/garbage locks', () => {
    const r = acquireFileLock(f);
    expect(acquireFileLock(f)).toBeNull();
    r();
    fs.writeFileSync(f, JSON.stringify({ pid: 999999, at: Date.now() }));
    expect(typeof acquireFileLock(f)).toBe('function');
    fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now() - 7_200_000 }));
    expect(typeof acquireFileLock(f)).toBe('function');
    fs.writeFileSync(f, 'garbage');
    expect(typeof acquireFileLock(f)).toBe('function');
  });
});

describe('scheduler catch-up and cross-process lock (B15)', () => {
  const mkStore = () => {
    const m = new Map();
    return { m, get: (n) => m.get(n) ?? null, set: (n, v) => m.set(n, v) };
  };
  it('catches up one missed run, not on first start, not when nothing was missed', async () => {
    const st = mkStore();
    let runs = 0;
    const s1 = createScheduler({ lastRunStore: st });
    s1.registerJob('j', '* * * * *', () => { runs++; }, { catchUp: true });
    s1.start(); await tick(); await s1.stop();
    expect(runs).toBe(0);
    st.m.set('j', new Date(Date.now() - 600_000).toISOString());
    const s2 = createScheduler({ lastRunStore: st });
    s2.registerJob('j', '* * * * *', () => { runs++; }, { catchUp: true });
    s2.start(); await tick(); await s2.stop();
    expect(runs).toBe(1);
    st.m.set('j', new Date().toISOString());
    const s3 = createScheduler({ lastRunStore: st });
    s3.registerJob('j', '0 0 1 1 *', () => { runs++; }, { catchUp: true });
    s3.start(); await tick(); await s3.stop();
    expect(runs).toBe(1);
  });
  it('catchUp requires a lastRunStore', () => {
    expect(() => createScheduler().registerJob('x', '* * * * *', () => {}, { catchUp: true })).toThrow(/lastRunStore/);
  });
  it('two schedulers sharing lockDir do not run the same job together', async () => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-'));
    let release;
    const a = createScheduler({ lockDir });
    a.registerJob('b', '0 0 1 1 *', () => new Promise((r) => { release = r; }));
    const running = a.runNow('b');
    const b = createScheduler({ lockDir });
    b.registerJob('b', '0 0 1 1 *', () => {});
    await expect(b.runNow('b')).rejects.toThrow(/another process/);
    release(); await running;
    await expect(b.runNow('b')).resolves.toBeUndefined();
  });
});
