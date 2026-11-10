import { describe, it, expect } from 'vitest';
import { registerStandardJobs, standardJobsChecks } from '../src/scheduler/standard-jobs.js';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';

function fakeScheduler() {
  const jobs = new Map();
  return { jobs, registerJob(name, cron, fn) { if (jobs.has(name)) throw new Error('dup'); jobs.set(name, { cron, fn }); } };
}

describe('registerStandardJobs', () => {
  it('registers a job only for each source that is given', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    const s = fakeScheduler();
    const names = registerStandardJobs(s, { db });
    expect(names).toEqual(['password-resets-gc']);
    const s2 = fakeScheduler();
    const all = registerStandardJobs(s2, { db, sessionStore: { purgeExpired: () => 0 }, bans: { purge() {} }, metrics: { purge() {} }, emailQueue: { purgeFinished: () => 0 }, auditRetentionDays: 90 });
    expect(all.sort()).toEqual(['audit-gc', 'bans-gc', 'email-queue-gc', 'metrics-gc', 'password-resets-gc', 'sessions-gc']);
  });

  it('the jobs call the right cleanup with the configured values', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    ensureAuthTables(db);
    const calls = [];
    const s = fakeScheduler();
    registerStandardJobs(s, { db, sessionStore: { purgeExpired: () => { calls.push('sessions'); return 2; } }, bans: { purge: () => calls.push('bans') }, metrics: { purge: () => calls.push('metrics') }, emailQueue: { purgeFinished: (o) => { calls.push(`mail:${o.olderThanDays}`); return 0; } }, mailKeepFinishedDays: 7 });
    for (const n of ['sessions-gc', 'bans-gc', 'metrics-gc', 'email-queue-gc']) s.jobs.get(n).fn();
    s.jobs.get('password-resets-gc').fn();
    expect(calls).toEqual(['sessions', 'bans', 'metrics', 'mail:7']);
  });

  it('audit retention 0 keeps rows forever: no audit job', () => {
    const s = fakeScheduler();
    registerStandardJobs(s, { db: createSqliteAdapter({ file: ':memory:' }), auditRetentionDays: 0 });
    expect(s.jobs.has('audit-gc')).toBe(false);
  });

  it('refuses a missing scheduler or database', () => {
    expect(() => registerStandardJobs(null, { db: {} })).toThrow(/scheduler/);
    expect(() => registerStandardJobs(fakeScheduler(), {})).toThrow(/db/);
  });

  it('doctor warns when the standard jobs were never registered on that scheduler', () => {
    const s = fakeScheduler();
    expect(standardJobsChecks(s)[0].status).toBe('warn');
    expect(standardJobsChecks(null)[0].status).toBe('warn');
    registerStandardJobs(s, { db: createSqliteAdapter({ file: ':memory:' }) });
    const c = standardJobsChecks(s)[0];
    expect(c.status).toBe('ok');
    expect(c.message).toContain('password-resets-gc');
  });
});
