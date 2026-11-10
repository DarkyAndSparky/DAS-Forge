import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createAdmin } from '../src/admin/index.js';
import { createScheduler, createTaskSchedules, describeCron } from '../src/scheduler/index.js';
import { query } from '../src/audit/index.js';

function setup() {
  const db = createSqliteAdapter({ file: ':memory:' });
  const scheduler = createScheduler({});
  scheduler.registerJob('sessions-gc', '15 * * * *', () => {});
  scheduler.registerJob('backup', '0 3 * * *', () => {});
  return { db, scheduler, ts: createTaskSchedules({ db, scheduler }) };
}

const codeOf = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

describe('describeCron', () => {
  it('reads common shapes in words, both languages', () => {
    expect(describeCron('0 3 * * *')).toBe('каждый день в 03:00');
    expect(describeCron('0 3 * * *', 'en')).toBe('every day at 03:00');
    expect(describeCron('30 4 * * 0')).toBe('каждую неделю: в воскресенье, 04:30');
    expect(describeCron('*/15 * * * *', 'en')).toBe('every 15 minutes');
    expect(describeCron('15 * * * *', 'en')).toBe('every hour, at minute 15');
  });
  it('spells out unusual ones and flags invalid ones', () => {
    expect(describeCron('1 2 3 4 5', 'en')).toContain('minute: 1');
    expect(describeCron('nonsense')).toBe('некорректное расписание');
  });
});

describe('createTaskSchedules', () => {
  it('moves a job, keeps the choice in the database, resets to the registered schedule', () => {
    const { db, scheduler, ts } = setup();
    expect(ts.set('sessions-gc', { time: '04:30' })).toBe('30 4 * * *');
    expect(scheduler.getJobStatus('sessions-gc').expression).toBe('30 4 * * *');
    expect(ts.isOverridden('sessions-gc')).toBe(true);
    // a fresh scheduler (restart) registers the default, apply() brings the override back
    const again = createScheduler({});
    again.registerJob('sessions-gc', '15 * * * *', () => {});
    createTaskSchedules({ db, scheduler: again }).apply();
    expect(again.getJobStatus('sessions-gc').expression).toBe('30 4 * * *');
    expect(ts.reset('sessions-gc')).toBe('15 * * * *');
    expect(scheduler.getJobStatus('sessions-gc').expression).toBe('15 * * * *');
    expect(ts.isOverridden('sessions-gc')).toBe(false);
  });
  it('refuses a bad expression and an unknown job without changing anything', () => {
    const { scheduler, ts } = setup();
    expect(codeOf(() => ts.set('backup', { cron: '99 * * * *' }))).toBe('CRON_INVALID');
    expect(codeOf(() => ts.set('backup', { cron: 'a b' }))).toBe('CRON_INVALID');
    expect(codeOf(() => ts.set('nope', { cron: '* * * * *' }))).toBe('UNKNOWN');
    expect(scheduler.getJobStatus('backup').expression).toBe('0 3 * * *');
  });
});

describe('tasks section: schedule form', () => {
  const user = { id: 1, username: 'root', permissions: ['admin.access'] };
  function build() {
    const { db, scheduler, ts } = setup();
    ensureAuthTables(db);
    const routes = {};
    const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
    const requireAuth = () => (req, res, next) => (req.user ? next() : res.status(401).end());
    const requirePermission = () => (req, res, next) => next();
    createAdmin({ db, scheduler: { listJobs: () => scheduler.listJobs(), runNow: (n) => scheduler.runNow(n) }, taskSchedules: ts, managedTasks: { backup: 'backups' } }).mount(app, { requireAuth, requirePermission });
    return { db, routes, scheduler };
  }
  const call = (chain, req) => new Promise((resolve) => {
    const res = { body: '', locals: {}, set() { return this; }, type() { return this; } };
    res.send = (b) => { res.body = b; resolve(res); return res; };
    res.redirect = (c, loc) => { res.location = loc; resolve(res); return res; };
    let i = 0;
    const next = () => { const h = chain[i++]; if (h) Promise.resolve(h(req, res, next)).catch((e) => { res.body = String(e); resolve(res); }); };
    next();
  });

  it('shows the reading and a form; a managed task links to its own section', async () => {
    const { routes } = build();
    const page = await call(routes['GET /admin/tasks'], { user, query: {} });
    expect(page.body).toContain('каждый час, в 15 мин');
    expect(page.body).toContain('/admin/tasks/sessions-gc/schedule');
    expect(page.body).not.toContain('/admin/tasks/backup/schedule');
    expect(page.body).toContain('/admin/backups');
  });
  it('saves, audits, resets; bad input and managed tasks are refused', async () => {
    const { db, routes, scheduler } = build();
    const post = (name, path, body) => call(routes[`POST /admin/tasks/:name/${path}`], { user, params: { name }, body, query: {} });
    let r = await post('sessions-gc', 'schedule', { cron: '*/10 * * * *', time: '' });
    expect(r.location).toBe('/admin/tasks?msg=ok&e=SCHED');
    expect(scheduler.getJobStatus('sessions-gc').expression).toBe('*/10 * * * *');
    expect(query(db, { action: 'admin.task.schedule' }).length).toBe(1);
    r = await post('sessions-gc', 'schedule', { cron: 'bad', time: '' });
    expect(r.location).toBe('/admin/tasks?msg=bad&e=CRON_INVALID');
    r = await post('backup', 'schedule', { cron: '* * * * *' });
    expect(r.location).toBe('/admin/tasks?msg=bad&e=UNKNOWN');
    r = await post('sessions-gc', 'schedule-reset', { x: '1' });
    expect(scheduler.getJobStatus('sessions-gc').expression).toBe('15 * * * *');
  });
});
