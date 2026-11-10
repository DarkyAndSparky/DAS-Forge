import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';

function make(opts) {
  const db = createSqliteAdapter({ file: ':memory:', ...opts });
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, active BOOLEAN, born DATE, seen DATETIME, note TEXT)`);
  return db;
}
// StatementSync.columns() arrived in Node 23.11; older runtimes can only test the write side.
const canReadTypes = typeof make({}).raw.prepare('SELECT 1').columns === 'function';

describe('normalizeValues (B17, opt-in)', () => {
  it('is off by default: rows come back exactly as stored', () => {
    const db = make({});
    db.run("INSERT INTO t (active, seen) VALUES (1, '2026-01-02 03:04:05')");
    expect(db.get('SELECT active, seen FROM t').active).toBe(1);
    expect(db.get('SELECT seen FROM t').seen).toBe('2026-01-02 03:04:05');
  });

  it('write side: Date becomes ISO text (UTC), boolean becomes 1/0, an invalid Date is refused', () => {
    const db = make({ normalizeValues: true });
    db.run('INSERT INTO t (id, active, seen, note) VALUES (?, ?, ?, ?)', [1, true, new Date('2026-03-04T05:06:07.000Z'), 'x']);
    db.run('INSERT INTO t (id, active) VALUES (?, ?)', [2, false]);
    expect(db.raw.prepare('SELECT active, seen FROM t WHERE id = 1').get().seen).toBe('2026-03-04T05:06:07.000Z');
    expect(db.raw.prepare('SELECT active FROM t WHERE id = 2').get().active).toBe(0);
    expect(() => db.run('INSERT INTO t (id, seen) VALUES (3, ?)', [new Date('nope')])).toThrow(/Invalid Date/);
  });

  it('read side: declared BOOLEAN and DATE/DATETIME columns come back as boolean and Date; others and expressions are untouched', () => {
    if (!canReadTypes) return;
    const db = make({ normalizeValues: true });
    db.run("INSERT INTO t (id, active, born, seen, note) VALUES (1, 1, '2000-02-29', '2026-01-02 03:04:05', 'n')");
    db.run("INSERT INTO t (id, active, born, seen, note) VALUES (2, 0, NULL, NULL, NULL)");
    const a = db.get('SELECT * FROM t WHERE id = 1');
    expect(a.active).toBe(true);
    expect(a.born.toISOString()).toBe('2000-02-29T00:00:00.000Z');
    expect(a.seen.toISOString()).toBe('2026-01-02T03:04:05.000Z'); // zone-less SQLite text is UTC
    expect(a.note).toBe('n');
    const b = db.all('SELECT * FROM t WHERE id = 2')[0];
    expect(b.active).toBe(false);
    expect(b.born).toBe(null);
    expect(db.get("SELECT strftime('%Y', '2026-01-01') AS y").y).toBe('2026');
    expect(db.get('SELECT id + 1 AS n FROM t WHERE id = 1').n).toBe(2);
  });

  it('a round trip returns an equal Date, and unparsable text stays as stored', () => {
    if (!canReadTypes) return;
    const db = make({ normalizeValues: true });
    const when = new Date('2026-05-06T07:08:09.123Z');
    db.run('INSERT INTO t (id, seen) VALUES (?, ?)', [1, when]);
    expect(db.get('SELECT seen FROM t WHERE id = 1').seen.getTime()).toBe(when.getTime());
    db.run("INSERT INTO t (id, seen) VALUES (2, 'not a date')");
    expect(db.get('SELECT seen FROM t WHERE id = 2').seen).toBe('not a date');
  });

  it('queryByExample and countByExample keep working with it on', () => {
    const db = make({ normalizeValues: true });
    db.run('INSERT INTO t (id, active) VALUES (?, ?)', [1, true]);
    db.run('INSERT INTO t (id, active) VALUES (?, ?)', [2, false]);
    expect(db.queryByExample('t', { id: [1, 2] }).length).toBe(2);
    expect(Number(db.countByExample('t', { id: [1, 2] }))).toBe(2);
  });
});
