import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { log, summarizeAudit } from '../src/audit/index.js';

describe('audit summary (stage C)', () => {
  it('counts sign-ins, failures, lockouts and names the noisiest addresses', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    log(db, { actor: 'ann', action: 'auth.login', ip: '1.1.1.1' });
    log(db, { actor: 'bob', action: 'auth.login', ip: '1.1.1.2' });
    log(db, { actor: 'bob', action: 'auth.login', ip: '1.1.1.2' });
    for (let i = 0; i < 3; i += 1) log(db, { actor: 'admin', action: 'auth.login', result: 'failure', ip: '9.9.9.9' });
    log(db, { actor: 'x', action: 'auth.login', result: 'failure', ip: '8.8.8.8' });
    log(db, { actor: 'admin', action: 'auth.lockout', result: 'failure', ip: '9.9.9.9' });
    log(db, { actor: 'ann', action: 'admin.user.create' });
    const r = summarizeAudit(db, { since: new Date(Date.now() - 86_400_000).toISOString(), until: new Date(Date.now() + 1000).toISOString() });
    expect(r.totals).toMatchObject({ events: 9, logins: 3, loginFailures: 4, lockouts: 1, adminActions: 1, activeUsers: 2 });
    expect(r.topFailedIps[0].count).toBe(3); // addresses are stored pseudonymised by default, so the key is not the raw address
    expect(r.topFailedIps[0].key).not.toBe('1.1.1.1');
    expect(r.topFailedLogins[0].count).toBe(3);
    expect(r.perDay).toHaveLength(1);
    expect(r.perDay[0]).toMatchObject({ logins: 3, failures: 4 });
  });
  it('an empty period gives zeros, not errors', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    log(db, { action: 'auth.login' });
    const r = summarizeAudit(db, { since: '2000-01-01T00:00:00Z', until: '2000-01-02T00:00:00Z' });
    expect(r.totals.events).toBe(0);
    expect(r.perDay).toEqual([]);
  });
});
