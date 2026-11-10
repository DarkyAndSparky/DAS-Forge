import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createSqliteAdapter } from '../src/database/index.js';
import { log, tail, query, purgeOlderThan, verifyChain, redactMeta } from '../src/audit/index.js';
import { parseCron, getNextRun } from '../src/scheduler/cron-parse.js';
import { createScheduler } from '../src/scheduler/scheduler.js';

/** Audit wave 2c: B14 (tamper-evident audit log) and B15 (cron/scheduler). */

describe('audit hash chain (B14)', () => {
  let db;
  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
  });
  afterEach(() => db.close());

  it('an untouched log verifies', () => {
    for (let i = 0; i < 5; i++) log(db, { actor: 'a', action: `act.${i}`, meta: { i } });
    expect(verifyChain(db)).toEqual({ ok: true, checked: 5 });
  });

  it('UPDATE on an audit row is refused by the database itself', () => {
    log(db, { action: 'x' });
    expect(() => db.run(`UPDATE audit_log SET actor = 'mallory'`)).toThrow(/append-only/);
  });

  it('a modified row is detected (trigger dropped by an attacker with file access)', () => {
    for (let i = 0; i < 3; i++) log(db, { action: `act.${i}` });
    db.exec('DROP TRIGGER audit_log_no_update');
    db.run(`UPDATE audit_log SET actor = 'mallory' WHERE action = 'act.1'`);
    const r = verifyChain(db);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/modified/);
    expect(r.brokenAtId).toBe(2);
  });

  it('a row deleted from the middle is detected', () => {
    for (let i = 0; i < 4; i++) log(db, { action: `act.${i}` });
    db.run('DELETE FROM audit_log WHERE id = 2');
    const r = verifyChain(db);
    expect(r.ok).toBe(false);
    expect(r.brokenAtId).toBe(3);
    expect(r.reason).toMatch(/removed or reordered/);
  });

  it('purge of old rows leaves a verifiable log, and { record: true } audits the purge itself', () => {
    log(db, { action: 'old' });
    db.exec('DROP TRIGGER audit_log_no_update');
    db.run(`UPDATE audit_log SET created_at = '2020-01-01T00:00:00.000Z'`);
    db.exec(`CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;`);
    log(db, { action: 'new1' });
    log(db, { action: 'new2' });
    const removed = purgeOlderThan(db, '2021-01-01T00:00:00.000Z', { record: true, actor: 'system' });
    expect(removed).toBe(1);
    expect(tail(db).map((e) => e.action)).toEqual(['audit.purge', 'new2', 'new1']);
    expect(query(db, { action: 'audit.purge' })[0].meta).toMatchObject({ removed: 1 });
    expect(verifyChain(db).ok).toBe(true);
  });

  it('rows written before hashes existed are skipped, new rows chain from the first hashed one', () => {
    log(db, { action: 'first' }); // creates the table
    db.run(`INSERT INTO audit_log (action, result, meta, created_at) VALUES ('legacy', 'success', '{}', '2020-01-01T00:00:00.000Z')`);
    log(db, { action: 'after' });
    expect(verifyChain(db).ok).toBe(true);
  });

  it('upgrades a table created before hash columns existed', () => {
    const old = createSqliteAdapter({ file: ':memory:' });
    old.exec(`CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT NOT NULL, entity TEXT, entity_id TEXT, result TEXT NOT NULL DEFAULT 'success', meta TEXT NOT NULL DEFAULT '{}', request_id TEXT, ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    old.run(`INSERT INTO audit_log (action) VALUES ('legacy')`);
    log(old, { action: 'new' });
    expect(verifyChain(old)).toEqual({ ok: true, checked: 1 });
    old.close();
  });

  it('credential-looking meta keys are redacted before storage', () => {
    const e = log(db, { action: 'auth.login', meta: { username: 'bob', password: 'hunter2', nested: { apiKey: 'k', sessionToken: 't', ok: 1 }, list: [{ secret: 's' }] } });
    expect(e.meta).toEqual({ username: 'bob', password: '[REDACTED]', nested: { apiKey: '[REDACTED]', sessionToken: '[REDACTED]', ok: 1 }, list: [{ secret: '[REDACTED]' }] });
    expect(redactMeta(null)).toBeNull();
    expect(redactMeta('plain')).toBe('plain');
  });

  it('corrupt meta JSON does not make query() throw', () => {
    log(db, { action: 'ok' });
    db.exec('DROP TRIGGER audit_log_no_update');
    db.run(`UPDATE audit_log SET meta = '{not json'`);
    expect(query(db)[0].meta).toEqual({ _unparseable: true });
  });

  it('clamps hostile limit/offset', () => {
    for (let i = 0; i < 3; i++) log(db, { action: `a${i}` });
    expect(query(db, { limit: 'abc' })).toHaveLength(3);
    expect(query(db, { limit: -1, offset: -5 })).toHaveLength(3);
    expect(query(db, { limit: 1 })).toHaveLength(1);
    expect(tail(db, { limit: 'x' })).toHaveLength(3);
  });

});

describe('cron parsing (B15)', () => {
  it('rejects step 0, malformed numbers and malformed ranges instead of hanging', () => {
    for (const expr of ['*/0 * * * *', '1-5/0 * * * *', '5x * * * *', '* * * * 1-', '1--3 * * * *', '*/ * * * *', '*/x * * * *', ' */-1 * * * *']) {
      expect(() => parseCron(expr)).toThrow();
    }
  });

  it('accepts 7 as Sunday', () => {
    const p = parseCron('0 3 * * 7');
    expect([...p.dayOfWeek]).toEqual([0]);
    expect([...parseCron('0 3 * * 5-7').dayOfWeek].sort()).toEqual([0, 5, 6]);
  });

  it('still parses the normal forms', () => {
    expect(parseCron('*/15 * * * *').minute.size).toBe(4);
    expect(getNextRun('0 3 * * *', new Date(2026, 0, 1, 2, 0)).getHours()).toBe(3);
  });
});

describe('scheduler (B15)', () => {
  it('stop() resolves only after a running job has finished', async () => {
    const s = createScheduler();
    let release;
    let finished = false;
    s.registerJob('slow', '* * * * *', () => new Promise((r) => (release = r)).then(() => { finished = true; }));
    const running = s.runNow('slow');
    const stopped = s.stop();
    let stoppedEarly = true;
    stopped.then(() => { stoppedEarly = !finished; });
    release();
    await running;
    await stopped;
    expect(stoppedEarly).toBe(false);
  });

  it('stop() with nothing running resolves immediately', async () => {
    const s = createScheduler();
    s.registerJob('a', '* * * * *', () => {});
    expect(await s.stop()).toBeUndefined();
  });
});
