import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/sqlite-adapter.js';
import { asyncDb, assertAsyncDatabase, atomicAsync } from '../src/database/async.js';

const tick = () => new Promise((r) => setTimeout(r, 1));
function fresh() {
  const db = createSqliteAdapter({ file: ':memory:' });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL)');
  return db;
}

describe('asyncDb over a synchronous adapter', () => {
  it('answers get / all / run / exec as promises and is the same object each time', async () => {
    const db = fresh();
    const a = asyncDb(db);
    expect(asyncDb(db)).toBe(a);
    expect(a.dialect).toBe('sqlite');
    assertAsyncDatabase(a);
    const info = await a.run('INSERT INTO t (v) VALUES (?)', ['x']);
    expect(Number(info.lastInsertRowid)).toBe(1);
    await a.exec("INSERT INTO t (v) VALUES ('y')");
    expect((await a.get('SELECT v FROM t WHERE id = ?', [1])).v).toBe('x');
    expect((await a.all('SELECT v FROM t ORDER BY id')).map((r) => r.v)).toEqual(['x', 'y']);
    expect(await a.get('SELECT v FROM t WHERE id = 99')).toBeUndefined();
  });

  it('commits a transaction with awaits inside, and rolls back when it throws', async () => {
    const a = asyncDb(fresh());
    const r = await a.transaction(async (tx) => { await tx.run("INSERT INTO t (v) VALUES ('a')"); await tick(); await tx.run("INSERT INTO t (v) VALUES ('b')"); return 7; });
    expect(r).toBe(7);
    await expect(a.transaction(async (tx) => { await tx.run("INSERT INTO t (v) VALUES ('c')"); throw new Error('boom'); })).rejects.toThrow('boom');
    expect((await a.all('SELECT v FROM t ORDER BY id')).map((x) => x.v)).toEqual(['a', 'b']);
  });

  it('nested transactions are savepoints: the inner one can fail alone', async () => {
    const a = asyncDb(fresh());
    await a.transaction(async (tx) => {
      await tx.run("INSERT INTO t (v) VALUES ('outer')");
      await tx.transaction(async (inner) => { await inner.run("INSERT INTO t (v) VALUES ('kept')"); });
      await expect(tx.transaction(async (inner) => { await inner.run("INSERT INTO t (v) VALUES ('lost')"); throw new Error('inner'); })).rejects.toThrow('inner');
    });
    expect((await a.all('SELECT v FROM t ORDER BY id')).map((x) => x.v)).toEqual(['outer', 'kept']);
  });

  it('two transactions at once run one after the other, never inside each other', async () => {
    const a = asyncDb(fresh());
    await a.run("INSERT INTO t (v) VALUES ('0')");
    const bump = async () => a.transaction(async (tx) => {
      const n = Number((await tx.get('SELECT v FROM t WHERE id = 1')).v);
      await tick(); // another request would get its turn here
      await tx.run('UPDATE t SET v = ? WHERE id = 1', [String(n + 1)]);
    }, { mode: 'immediate' });
    await Promise.all(Array.from({ length: 12 }, bump));
    expect((await a.get('SELECT v FROM t WHERE id = 1')).v).toBe('12'); // no lost update
  });

  it('a statement from outside waits for the open transaction and does not see its half-done work', async () => {
    const a = asyncDb(fresh());
    let seenOutside;
    const tx = a.transaction(async (t) => {
      await t.run("INSERT INTO t (v) VALUES ('inside')");
      await tick();
      expect((await t.all('SELECT v FROM t')).length).toBe(1);
      await tick();
    });
    const outside = (async () => { await tick(); seenOutside = (await a.all('SELECT v FROM t')).length; })();
    await Promise.all([tx, outside]);
    expect(seenOutside).toBe(1); // it waited, then saw the committed row
    const rolled = a.transaction(async (t) => { await t.run("INSERT INTO t (v) VALUES ('gone')"); await tick(); throw new Error('no'); }).catch(() => {});
    const out2 = (async () => { await tick(); return (await a.all('SELECT v FROM t')).length; })();
    await rolled;
    expect(await out2).toBe(1); // the rolled-back row was never visible
  });

  it('atomicAsync takes the write lock at once; bad arguments are refused', async () => {
    const a = asyncDb(fresh());
    expect(await atomicAsync(a, async (tx) => { await tx.run("INSERT INTO t (v) VALUES ('z')"); return 'ok'; })).toBe('ok');
    await expect(a.transaction(() => 1, { mode: 'weird' })).rejects.toThrow(TypeError);
    await expect(a.transaction(null)).rejects.toThrow(TypeError);
    expect(() => asyncDb(null)).toThrow(TypeError);
    expect(() => assertAsyncDatabase({ get() {}, all() {}, run() {}, exec() {}, transaction() {} })).toThrow(/dialect/);
  });

  it('uses the driver\'s own async object when the database has one', async () => {
    const own = { dialect: 'postgres', get: async () => 1, all: async () => [], run: async () => ({}), exec: async () => {}, transaction: async (fn) => fn(own) };
    expect(asyncDb({ async: own })).toBe(own);
  });
});

describe('asyncDb of an asynchronous database', () => {
  it('returns the same object, also the transaction handle, so helpers can be nested', async () => {
    const a = asyncDb(fresh());
    expect(asyncDb(a)).toBe(a);
    await a.transaction(async (tx) => { expect(asyncDb(tx)).toBe(tx); });
  });
});
