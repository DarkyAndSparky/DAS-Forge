import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createDbLastRunStore, ensureSchedulerStateTableAsync } from '../src/scheduler/state.js';
import { createScheduleSetting } from '../src/scheduler/schedule-setting.js';
import { createTaskSchedules } from '../src/scheduler/task-schedules.js';

const fresh = () => createSqliteAdapter({ file: ':memory:', walMode: false });

function fakeScheduler() {
  const jobs = new Map();
  return {
    jobs,
    registerJob: (name, expr) => jobs.set(name, { name, expression: expr, defaultExpression: expr }),
    unregisterJob: (name) => jobs.delete(name),
    listJobs: () => [...jobs.values()],
    reschedule: (name, expr) => { jobs.get(name).expression = expr; },
  };
}

describe('scheduler over the asynchronous database', () => {
  it('last-run store: async and sync share the row', async () => {
    const db = fresh();
    await ensureSchedulerStateTableAsync(db);
    const st = createDbLastRunStore(db);
    expect(await st.getAsync('j')).toBeNull();
    await st.setAsync('j', '2026-01-01T00:00:00.000Z');
    expect(st.get('j')).toBe('2026-01-01T00:00:00.000Z');
    await st.setAsync('j', '2026-01-02T00:00:00.000Z');
    expect(await st.getAsync('j')).toBe('2026-01-02T00:00:00.000Z');
  });
  it('schedule setting: defaults, set, apply', async () => {
    const db = fresh();
    const sch = fakeScheduler();
    const s = createScheduleSetting({ db, scheduler: sch, key: 'doctor', jobName: 'doctor', handler: () => {}, defaults: { enabled: false, schedule: '30 2 * * *' } });
    expect((await s.getAsync()).enabled).toBe(false);
    const v = await s.setAsync({ enabled: true, time: '04:15' });
    expect(v.enabled).toBe(true);
    expect(v.schedule).toBe('15 4 * * *');
    expect(sch.jobs.get('doctor').expression).toBe('15 4 * * *');
    expect(s.get().fromAdmin).toBe(true);
    let err;
    const fresh2 = createScheduleSetting({ db: fresh(), scheduler: fakeScheduler(), key: 'x', jobName: 'x', handler: () => {}, defaults: { enabled: false, schedule: null } });
    try { await fresh2.setAsync({ enabled: true }); } catch (e) { err = e; }
    expect(err?.code).toBe('TIME_INVALID');
  });
  it('task schedules: set, apply after restart, reset, unknown and bad cron', async () => {
    const db = fresh();
    const sch = fakeScheduler();
    sch.registerJob('purge', '0 3 * * *');
    const ts = createTaskSchedules({ db, scheduler: sch });
    expect(await ts.setAsync('purge', { time: '05:00' })).toBe('0 5 * * *');
    expect(await ts.isOverriddenAsync('purge')).toBe(true);
    const sch2 = fakeScheduler();
    sch2.registerJob('purge', '0 3 * * *');
    await createTaskSchedules({ db, scheduler: sch2 }).applyAsync();
    expect(sch2.jobs.get('purge').expression).toBe('0 5 * * *');
    expect(await ts.resetAsync('purge')).toBe('0 3 * * *');
    expect(ts.isOverridden('purge')).toBe(false);
    const code = async (fn) => { try { await fn(); } catch (e) { return e.code; } return null; };
    expect(await code(() => ts.setAsync('nope', { time: '01:00' }))).toBe('UNKNOWN');
    expect(await code(() => ts.setAsync('purge', { cron: 'bad' }))).toBe('CRON_INVALID');
  });
});

describe('health probe over the asynchronous database', () => {
  it('reports ok, and degraded when the database fails', async () => {
    const { checkHealthAsync, checkHealth } = await import('../src/health/index.js');
    const db = fresh();
    const ok = await checkHealthAsync(db, { version: '1.0.0' });
    expect(ok.status).toBe('ok');
    expect(ok.version).toBe('1.0.0');
    expect(ok.database).toBe(checkHealth(db).database);
    const bad = { get() { throw new Error('down'); } };
    expect((await checkHealthAsync(bad)).status).toBe('degraded');
  });
});

describe('scheduler start over an asynchronous last-run store', () => {
  it('catches up a missed run read through getAsync, and does not on a first start', async () => {
    const { createScheduler } = await import('../src/scheduler/index.js');
    const db = fresh();
    await ensureSchedulerStateTableAsync(db);
    const store = createDbLastRunStore(db);
    let ran = 0;
    const sch = createScheduler({ lastRunStore: store });
    sch.registerJob('daily', '0 3 * * *', () => { ran += 1; }, { catchUp: true });
    await store.setAsync('daily', '2020-01-01T00:00:00.000Z');
    await sch.startAsync();
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toBe(1);
    await sch.stop();

    const db2 = fresh();
    await ensureSchedulerStateTableAsync(db2);
    let ran2 = 0;
    const sch2 = createScheduler({ lastRunStore: createDbLastRunStore(db2) });
    sch2.registerJob('daily', '0 3 * * *', () => { ran2 += 1; }, { catchUp: true });
    await sch2.startAsync();
    await new Promise((r) => setTimeout(r, 50));
    expect(ran2).toBe(0);
    await sch2.stop();
  });
});
