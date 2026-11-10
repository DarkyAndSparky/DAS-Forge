import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  createSqliteAdapter,
  addUpdatedAtTrigger,
  addSoftDelete,
  softDelete,
  restoreDeleted,
  purgeDeleted,
  likeEscape,
} from '../src/database/index.js';

describe('query by example: operators, paging, soft delete (audit B17)', () => {
  let db;
  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER, note TEXT)`);
    const rows = [
      ['alpha', 1, null],
      ['beta', 5, 'x'],
      ['gamma', 10, '100%_sure'],
      ['delta', 20, 'y'],
      ['epsilon', 30, null],
    ];
    for (const r of rows) db.run('INSERT INTO t (name, qty, note) VALUES (?, ?, ?)', r);
  });
  afterEach(() => db.close());
  const names = (rows) => rows.map((r) => r.name);

  it('an array is IN, an empty array matches nothing, notIn of [] matches everything', () => {
    expect(names(db.queryByExample('t', { name: ['alpha', 'gamma'] }, { orderBy: 'id' }))).toEqual(['alpha', 'gamma']);
    expect(db.queryByExample('t', { name: [] })).toEqual([]);
    expect(db.queryByExample('t', { qty: { notIn: [] } }).length).toBe(5);
    expect(names(db.queryByExample('t', { qty: { notIn: [1, 5] } }, { orderBy: 'id' }))).toEqual(['gamma', 'delta', 'epsilon']);
  });

  it('comparisons and between combine with AND', () => {
    expect(names(db.queryByExample('t', { qty: { gte: 5, lt: 30 } }, { orderBy: 'qty' }))).toEqual(['beta', 'gamma', 'delta']);
    expect(names(db.queryByExample('t', { qty: { between: [10, 20] } }, { orderBy: 'qty' }))).toEqual(['gamma', 'delta']);
    expect(names(db.queryByExample('t', { note: { ne: null } }, { orderBy: 'id' }))).toEqual(['beta', 'gamma', 'delta']);
    expect(names(db.queryByExample('t', { qty: { ne: 5 } })).includes('beta')).toBe(false);
  });

  it('contains/startsWith match text literally; like takes a raw pattern', () => {
    expect(names(db.queryByExample('t', { note: { contains: '100%' } }))).toEqual(['gamma']);
    expect(db.queryByExample('t', { note: { contains: '%' } }).length).toBe(1);
    expect(db.queryByExample('t', { note: { contains: '_' } }).length).toBe(1);
    expect(names(db.queryByExample('t', { name: { startsWith: 'e' } }))).toEqual(['epsilon']);
    expect(names(db.queryByExample('t', { name: { like: '%ta' } }, { orderBy: 'id' }))).toEqual(['beta', 'delta']);
    expect(likeEscape('a%b_c\\')).toBe('a\\%b\\_c\\\\');
  });

  it('refuses unknown operators, bad shapes and unsafe identifiers', () => {
    expect(() => db.queryByExample('t', { qty: { gt: 1, bogus: 2 } })).toThrow();
    expect(() => db.queryByExample('t', { qty: {} })).toThrow();
    expect(() => db.queryByExample('t', { qty: { between: [1] } })).toThrow();
    expect(() => db.queryByExample('t', { qty: { in: 'x' } })).toThrow();
    expect(() => db.queryByExample('t', { 'qty; DROP TABLE t': 1 })).toThrow();
    expect(() => db.queryByExample('t', {}, { orderBy: ['id', 'name; --'] })).toThrow();
    expect(() => db.queryByExample('t', { qty: Array.from({ length: 1001 }, (_, i) => i) })).toThrow();
    expect(db.all('SELECT COUNT(*) AS n FROM t')[0].n).toBe(5);
  });

  it('limit, offset, several orderBy columns, offset without limit', () => {
    expect(names(db.queryByExample('t', {}, { orderBy: 'qty DESC', limit: 2 }))).toEqual(['epsilon', 'delta']);
    expect(names(db.queryByExample('t', {}, { orderBy: 'qty DESC', limit: 2, offset: 2 }))).toEqual(['gamma', 'beta']);
    expect(names(db.queryByExample('t', {}, { orderBy: ['note', 'qty DESC'] }))).toEqual(['epsilon', 'alpha', 'gamma', 'beta', 'delta']);
    expect(names(db.queryByExample('t', {}, { orderBy: 'id', offset: 3 }))).toEqual(['delta', 'epsilon']);
    expect(names(db.queryByExample('t', {}, { orderBy: 'id', limit: 1, offset: -5 }))).toEqual(['alpha']);
    expect(names(db.queryByExample('t', {}, { orderBy: 'id', limit: 1, offset: 'abc' }))).toEqual(['alpha']);
  });

  it('countByExample counts the same rows the query returns', () => {
    expect(db.countByExample('t', {})).toBe(5);
    expect(db.countByExample('t', { qty: { gt: 5 } })).toBe(3);
    expect(db.countByExample('t', { name: [] })).toBe(0);
  });

  it('soft delete: hide, filter modes, restore, purge', () => {
    expect(addSoftDelete(db, 't')).toBe(true);
    expect(addSoftDelete(db, 't')).toBe(false);
    expect(softDelete(db, 't', { name: ['alpha', 'beta'] })).toBe(2);
    expect(softDelete(db, 't', { name: 'alpha' })).toBe(0); // already deleted: untouched
    expect(db.countByExample('t', {})).toBe(5);
    expect(db.countByExample('t', {}, { deleted: 'exclude' })).toBe(3);
    expect(names(db.queryByExample('t', {}, { deleted: 'only', orderBy: 'id' }))).toEqual(['alpha', 'beta']);
    expect(() => softDelete(db, 't', {})).toThrow();
    expect(() => db.countByExample('t', {}, { deleted: 'maybe' })).toThrow();
    expect(restoreDeleted(db, 't', { name: 'beta' })).toBe(1);
    expect(db.countByExample('t', {}, { deleted: 'exclude' })).toBe(4);
    expect(purgeDeleted(db, 't', { olderThanDays: 1 })).toBe(0);
    db.run(`UPDATE t SET deleted_at = '2000-01-01T00:00:00.000Z' WHERE name = 'alpha'`);
    expect(purgeDeleted(db, 't', { olderThanDays: 1 })).toBe(1);
    expect(db.countByExample('t', {})).toBe(4);
    expect(() => purgeDeleted(db, 't', { olderThanDays: -1 })).toThrow();
  });

  it('updated_at trigger stamps every UPDATE, respects an explicit value, is idempotent', () => {
    expect(addUpdatedAtTrigger(db, 't')).toBe(true);
    expect(addUpdatedAtTrigger(db, 't')).toBe(false);
    expect(db.get('SELECT updated_at AS u FROM t WHERE name = ?', ['alpha']).u).toBe(null);
    db.run('UPDATE t SET qty = 2 WHERE name = ?', ['alpha']);
    const u = db.get('SELECT updated_at AS u FROM t WHERE name = ?', ['alpha']).u;
    expect(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(u)).toBe(true);
    expect(db.get('SELECT updated_at AS u FROM t WHERE name = ?', ['beta']).u).toBe(null);
    db.run(`UPDATE t SET updated_at = '2001-02-03T00:00:00.000Z' WHERE name = 'beta'`);
    expect(db.get('SELECT updated_at AS u FROM t WHERE name = ?', ['beta']).u).toBe('2001-02-03T00:00:00.000Z');
    expect(() => addUpdatedAtTrigger(db, 't; DROP')).toThrow();
  });
});

describe('prepared statement cache (audit B17)', () => {
  it('reuses statements, evicts the least recently used, and can be turned off', () => {
    const db = createSqliteAdapter({ file: ':memory:', statementCacheSize: 2 });
    db.exec('CREATE TABLE a (x INTEGER)');
    db.run('INSERT INTO a VALUES (?)', [1]);
    const base = db.statementCacheStats();
    db.get('SELECT x FROM a WHERE x = ?', [1]);
    db.get('SELECT x FROM a WHERE x = ?', [1]);
    const s1 = db.statementCacheStats();
    expect(s1.hits - base.hits).toBe(1);
    expect(s1.misses - base.misses).toBe(1);
    db.get('SELECT 1 AS q');
    db.get('SELECT 2 AS q');
    expect(db.statementCacheStats().size).toBe(2);
    db.close();

    const off = createSqliteAdapter({ file: ':memory:', statementCacheSize: 0 });
    off.get('SELECT 1 AS q');
    off.get('SELECT 1 AS q');
    expect(off.statementCacheStats().size).toBe(0);
    off.close();
  });

  it('DDL drops cached statements, so a changed schema is seen at once', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    db.exec('CREATE TABLE a (x INTEGER)');
    db.run('INSERT INTO a VALUES (1)');
    expect(Object.keys(db.get('SELECT * FROM a'))).toEqual(['x']);
    db.run('ALTER TABLE a ADD COLUMN y TEXT');
    expect(Object.keys(db.get('SELECT * FROM a'))).toEqual(['x', 'y']);
    db.exec('DROP TABLE a');
    expect(() => db.get('SELECT * FROM a')).toThrow();
    db.close();
  });

  it('a statement used inside a transaction and after a rollback still works', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    db.exec('CREATE TABLE a (x INTEGER)');
    expect(() => db.transaction((tx) => { tx.run('INSERT INTO a VALUES (?)', [1]); throw new Error('no'); })).toThrow();
    db.run('INSERT INTO a VALUES (?)', [2]);
    expect(JSON.stringify(db.all('SELECT x FROM a'))).toBe('[{"x":2}]');
    db.close();
  });
});
