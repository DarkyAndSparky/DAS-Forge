import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuditTable, log } from '../src/audit/index.js';
import { summarize, summarizeAsync } from '../src/audit/summary.js';

describe('audit summary over the asynchronous database', () => {
  it('gives exactly the synchronous summary', async () => {
    const db = createSqliteAdapter({ file: ':memory:', walMode: false });
    ensureAuditTable(db);
    for (let i = 0; i < 3; i += 1) log(db, { actor: 'ann', action: 'auth.login', entity: 'user', ip: '1.1.1.1' });
    for (let i = 0; i < 2; i += 1) log(db, { actor: 'eve', action: 'auth.login', entity: 'user', result: 'failure', ip: '6.6.6.6' });
    log(db, { actor: 'root', action: 'admin.user.create', entity: 'user' });
    const period = { since: '2000-01-01T00:00:00Z' };
    const a = await summarizeAsync(db, { ...period, until: '2999-01-01T00:00:00Z' });
    expect(a).toEqual(summarize(db, { ...period, until: '2999-01-01T00:00:00Z' }));
    expect(a.totals.logins).toBe(3);
    expect(a.totals.loginFailures).toBe(2);
    expect(a.totals.adminActions).toBe(1);
    expect(a.topFailedIps[0].count).toBe(2); // the address is kept as a pseudonym
  });
});
