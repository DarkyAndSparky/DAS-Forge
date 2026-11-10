import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { log, query, page, count, anchor, verifyChain, normalizeTimestamp } from '../src/audit/index.js';

function seeded(n = 25) {
  const db = createSqliteAdapter({ file: ':memory:' });
  for (let i = 1; i <= n; i++) log(db, { action: `a${i}`, actor: 'u' });
  return db;
}

describe('audit timestamps (B14)', () => {
  it('normalizes Date / ISO / SQLite formats and rejects garbage', () => {
    expect(normalizeTimestamp('2020-01-01 10:00:00')).toBe('2020-01-01T10:00:00.000Z');
    expect(normalizeTimestamp(new Date('2020-01-01T10:00:00Z'))).toBe('2020-01-01T10:00:00.000Z');
    expect(() => normalizeTimestamp('garbage')).toThrow(TypeError);
  });
  it('legacy "YYYY-MM-DD HH:MM:SS" rows are range-filtered correctly', () => {
    const db = seeded(2);
    db.run(`INSERT INTO audit_log (action, created_at) VALUES ('legacy', '2020-01-01 10:00:00')`);
    expect(query(db, { until: new Date('2020-01-01T10:00:00Z') }).map((e) => e.action)).toEqual(['legacy']);
    expect(query(db, { since: '2020-01-01 10:00:01', until: '2020-01-02' })).toHaveLength(0);
    expect(() => query(db, { since: 'garbage' })).toThrow(TypeError);
  });
});

describe('audit keyset paging (B14)', () => {
  it('walks every row exactly once via nextBeforeId', () => {
    const db = seeded(25);
    const seen = [];
    let cur = page(db, { limit: 10 });
    seen.push(...cur.items.map((e) => e.id));
    while (cur.nextBeforeId) {
      cur = page(db, { limit: 10, beforeId: cur.nextBeforeId });
      seen.push(...cur.items.map((e) => e.id));
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(count(db, { actor: 'u' })).toBe(25);
  });
  it('afterId returns newer entries oldest-first', () => {
    const db = seeded(25);
    const r = query(db, { afterId: 20 });
    expect(r.map((e) => e.id)).toEqual([21, 22, 23, 24, 25]);
  });
});

describe('audit external anchor (B14)', () => {
  it('verifies with an anchor, survives growth, detects tail truncation', () => {
    const db = seeded(10);
    const a = anchor(db);
    expect(a.count).toBe(10);
    expect(verifyChain(db, { anchor: a }).ok).toBe(true);
    log(db, { action: 'later' });
    expect(verifyChain(db, { anchor: a }).ok).toBe(true);
    for (const t of db.all(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)) db.exec(`DROP TRIGGER ${t.name}`);
    db.run('DELETE FROM audit_log WHERE id >= ?', [a.id]);
    const v = verifyChain(db, { anchor: a });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/anchored row is missing/);
  });
  it('anchor() is null on an empty log', () => {
    expect(anchor(createSqliteAdapter({ file: ':memory:' }))).toBeNull();
  });
});
