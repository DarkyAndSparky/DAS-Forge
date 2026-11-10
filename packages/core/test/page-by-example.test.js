import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';

function seeded() {
  const db = createSqliteAdapter({ file: ':memory:' });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, kind TEXT, deleted_at TEXT)');
  for (let i = 1; i <= 25; i++) db.run('INSERT INTO t (kind) VALUES (?)', [i % 5 === 0 ? 'x' : 'y']);
  return db;
}

describe('pageByExample (keyset paging)', () => {
  it('walks every row exactly once, last page has no cursor', () => {
    const db = seeded();
    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const p = db.pageByExample('t', {}, { pageSize: 10, cursor });
      seen.push(...p.rows.map((r) => r.id));
      cursor = p.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('is stable when rows are inserted or removed between pages', () => {
    const db = seeded();
    const first = db.pageByExample('t', {}, { pageSize: 10 });
    db.run('DELETE FROM t WHERE id <= 3');
    db.run('INSERT INTO t (kind) VALUES (?)', ['z']);
    const second = db.pageByExample('t', {}, { pageSize: 10, cursor: first.nextCursor });
    expect(second.rows[0].id).toBe(11);
  });

  it('filters by example, supports desc order and a total', () => {
    const db = seeded();
    const p = db.pageByExample('t', { kind: 'x' }, { pageSize: 2, direction: 'desc', withTotal: true });
    expect(p.rows.map((r) => r.id)).toEqual([25, 20]);
    expect(p.total).toBe(5);
    expect(p.nextCursor).not.toBeNull();
  });

  it('rejects a tampered cursor and unsafe identifiers', () => {
    const db = seeded();
    expect(() => db.pageByExample('t', {}, { cursor: '!!not-a-cursor' })).toThrow(/cursor/);
    expect(() => db.pageByExample('t', {}, { orderBy: 'id; DROP TABLE t' })).toThrow(/Unsafe/);
    expect(db.pageByExample('t', {}, { cursor: Buffer.from(JSON.stringify("1' OR '1'='1")).toString('base64url') }).rows.length).toBe(0);
  });
});
