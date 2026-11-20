import { describe, it, expect } from 'vitest';
import {
  createSqliteAdapter, asyncDb, upsertAsync, rebuildTableAsync, addColumnIfMissingAsync, addUpdatedAtTriggerAsync,
  addSoftDeleteAsync, softDeleteAsync, restoreDeletedAsync, purgeDeletedAsync,
} from '../src/database/index.js';

function makeDb() {
  const db = createSqliteAdapter({ file: ':memory:', walMode: false });
  db.exec(`CREATE TABLE people (id INTEGER PRIMARY KEY, first TEXT, last TEXT UNIQUE, legacy TEXT);
           CREATE INDEX idx_people_first ON people(first);
           CREATE TABLE notes (id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id), body TEXT);`);
  db.run(`INSERT INTO people (first,last,legacy) VALUES ('Ada','Lovelace','x'),('Alan','Turing','y')`);
  db.run(`INSERT INTO notes (person_id, body) VALUES (1,'a'),(2,'b')`);
  return db;
}

describe('asynchronous database helpers', () => {
  it('upsertAsync inserts, updates and can do nothing on conflict', async () => {
    const db = makeDb();
    await upsertAsync(db, 'people', { first: 'Ada2', last: 'Lovelace' }, ['last']);
    expect(db.get("SELECT first FROM people WHERE last = 'Lovelace'").first).toBe('Ada2');
    await upsertAsync(db, 'people', { first: 'Zed', last: 'Lovelace' }, ['last'], { updateColumns: [] });
    expect(db.get("SELECT first FROM people WHERE last = 'Lovelace'").first).toBe('Ada2');
    await expect(upsertAsync(db, 'people; DROP', { a: 1 }, ['a'])).rejects.toThrow();
  });

  it('addColumnIfMissingAsync is idempotent', async () => {
    const db = makeDb();
    expect(await addColumnIfMissingAsync(db, 'people', 'age', 'INTEGER')).toBe(true);
    expect(await addColumnIfMissingAsync(db, 'people', 'age', 'INTEGER')).toBe(false);
  });

  it('updated_at trigger stamps the column once and only once is created', async () => {
    const db = makeDb();
    expect(await addUpdatedAtTriggerAsync(db, 'people')).toBe(true);
    expect(await addUpdatedAtTriggerAsync(db, 'people')).toBe(false);
    db.run("UPDATE people SET first = 'Q' WHERE id = 1");
    expect(db.get('SELECT updated_at FROM people WHERE id = 1').updated_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('soft delete: hide, restore, purge', async () => {
    const db = makeDb();
    expect(await addSoftDeleteAsync(db, 'people')).toBe(true);
    expect(await softDeleteAsync(db, 'people', { first: 'Ada' })).toBe(1);
    expect(await softDeleteAsync(db, 'people', { first: 'Ada' })).toBe(0);
    await expect(softDeleteAsync(db, 'people', {})).rejects.toThrow(/empty/);
    expect(await restoreDeletedAsync(db, 'people', { first: 'Ada' })).toBe(1);
    await softDeleteAsync(db, 'people', { first: 'Ada' });
    expect(await purgeDeletedAsync(db, 'people', { olderThanDays: 1 })).toBe(0);
    db.run('DELETE FROM notes');
    await new Promise((r) => setTimeout(r, 5));
    expect(await purgeDeletedAsync(db, 'people', { olderThanDays: 0 })).toBe(1);
    await expect(purgeDeletedAsync(db, 'people', { olderThanDays: -1 })).rejects.toThrow();
  });

  it('rebuildTableAsync keeps rows, indexes and foreign-key setting; rolls back on violation', async () => {
    const db = makeDb();
    const r = await rebuildTableAsync(db, 'people', 'CREATE TABLE people (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, first TEXT)', { copy: { full_name: "first || ' ' || last" } });
    expect(r.rows).toBe(2);
    expect(db.all('SELECT full_name FROM people ORDER BY id').map((x) => x.full_name)).toEqual(['Ada Lovelace', 'Alan Turing']);
    expect(db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'idx_people_first'")).toBeTruthy();
    expect(Number(db.get('PRAGMA foreign_keys').foreign_keys)).toBe(1);
    await expect(
      rebuildTableAsync(db, 'people', 'CREATE TABLE people (id INTEGER PRIMARY KEY, full_name TEXT, first TEXT)', { copy: { id: 'id + 100' } })
    ).rejects.toThrow(/foreign key/);
    expect(db.all('SELECT id FROM people ORDER BY id').map((x) => x.id)).toEqual([1, 2]);
    expect(Number(db.get('PRAGMA foreign_keys').foreign_keys)).toBe(1);
  });

  it('refuses SQLite-only helpers on another dialect with a clear message', async () => {
    const fake = { dialect: 'postgres', get: async () => undefined, all: async () => [], run: async () => ({ changes: 0 }), exec: async () => {}, transaction: async (f) => f({}) };
    const db = { async: fake };
    expect(asyncDb(db).dialect).toBe('postgres');
    await expect(rebuildTableAsync(db, 'people', 'CREATE TABLE people (id INT)')).rejects.toThrow(/postgres/);
    await expect(addUpdatedAtTriggerAsync(db, 'people')).rejects.toThrow(/postgres/);
  });
});
