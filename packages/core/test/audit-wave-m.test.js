import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { log, verifyChain } from '../src/audit/index.js';


describe('I04: verifyChain pages', () => {
  it('verifies more rows than one page and still finds a broken row after the first page', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    for (let i = 0; i < 4500; i++) log(db, { action: 'a', meta: { i } });
    expect(verifyChain(db)).toMatchObject({ ok: true, checked: 4500 });
    db.exec('DROP TRIGGER audit_log_no_update');
    db.run(`UPDATE audit_log SET result = 'failure' WHERE id = 3000`);
    const r = verifyChain(db);
    expect(r.ok).toBe(false);
    expect(r.brokenAtId).toBe(3000);
  });
});

describe('I05: date filters use an index', () => {
  it('since/until query plan uses the ISO expression index and still handles legacy rows', async () => {
    const { query } = await import('../src/audit/index.js');
    const db = createSqliteAdapter({ file: ':memory:' });
    log(db, { action: 'new' });
    db.run(`INSERT INTO audit_log (action, created_at) VALUES ('legacy', '2020-01-01 10:00:00')`);
    const plan = db.all(
      `EXPLAIN QUERY PLAN SELECT * FROM audit_log WHERE (CASE WHEN created_at LIKE '____-__-__ %' THEN replace(created_at, ' ', 'T') || '.000Z' ELSE created_at END) >= ?`,
      ['2020-01-01T00:00:00.000Z']
    ).map((r) => r.detail).join(' ');
    expect(plan.includes('idx_audit_log_created_iso')).toBe(true);
    expect(query(db, { since: '2020-01-01T09:00:00.000Z', until: '2020-01-01T11:00:00.000Z' }).map((e) => e.action)).toEqual(['legacy']);
  });
});
