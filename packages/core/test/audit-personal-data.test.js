import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { log, query, verifyChain, purgePersonalData, ERASED } from '../src/audit/index.js';
import { registerStandardJobs } from '../src/scheduler/standard-jobs.js';

const DAY = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

function seeded() {
  const db = createSqliteAdapter({ file: ':memory:' });
  log(db, { actor: 'alice', action: 'auth.login', ip: '203.0.113.5', meta: { username: 'alice' } });
  log(db, { actor: 'bob', action: 'auth.login', ip: '198.51.100.9' });
  return db;
}

describe('separate retention of personal details (G-13)', () => {
  it('erases the real login/IP unseen for N days; the rows and the chain stay', () => {
    const db = seeded();
    db.run(`UPDATE audit_subjects SET last_seen_day = ? WHERE value IN ('alice', '203.0.113.5')`, [daysAgo(120)]);
    const removed = purgePersonalData(db, 90, { record: false });
    expect(removed).toBe(2);
    const rows = query(db, {}).sort((a, b) => a.id - b.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].actor).toBe(ERASED);
    expect(rows[0].ip).toBe(ERASED);
    expect(rows[0].action).toBe('auth.login');
    expect(rows[0].meta.username).toBe(ERASED);
    expect(rows[1].actor).toBe('bob');
    expect(rows[1].ip).toBe('198.51.100.9');
    expect(verifyChain(db)).toEqual({ ok: true, checked: 2 });
  });

  it('keeps what was seen recently, and records the cleanup in the journal', () => {
    const db = seeded();
    db.run(`UPDATE audit_subjects SET last_seen_day = ? WHERE value = 'bob'`, [daysAgo(10)]);
    expect(purgePersonalData(db, 90, { actor: 'system' })).toBe(0);
    db.run(`UPDATE audit_subjects SET last_seen_day = ? WHERE value = 'bob'`, [daysAgo(200)]);
    expect(purgePersonalData(db, 90, { actor: 'system' })).toBe(1);
    const entry = query(db, { action: 'audit.personal_data.purge' })[0];
    expect(entry.meta).toMatchObject({ days: 90, removed: 1 });
    expect(verifyChain(db).ok).toBe(true);
  });

  it('refuses a wrong number of days', () => {
    const db = seeded();
    for (const d of [0, -1, 'x', NaN]) expect(() => purgePersonalData(db, d)).toThrow(/days must be/);
  });

  it('the scheduled job exists only when the period is set', () => {
    const jobs = new Map();
    const scheduler = { registerJob: (name, cron, fn) => jobs.set(name, { cron, fn }) };
    const db = seeded();
    registerStandardJobs(scheduler, { db });
    expect(jobs.has('audit-personal-gc')).toBe(false);
    const s2 = { registerJob: (name, cron, fn) => jobs.set(name, { cron, fn }) };
    registerStandardJobs(s2, { db, auditPersonalDataDays: 90 });
    expect(jobs.has('audit-personal-gc')).toBe(true);
    db.run(`UPDATE audit_subjects SET last_seen_day = ?`, [daysAgo(400)]);
    jobs.get('audit-personal-gc').fn();
    expect(query(db, { action: 'auth.login' }).every((e) => e.actor === ERASED)).toBe(true);
  });
});
