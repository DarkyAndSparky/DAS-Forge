import { describe, it, expect } from 'vitest';
import { createSqliteAdapter, rebuildTable } from '../src/database/index.js';

function makeDb() {
  const db = createSqliteAdapter({ file: ':memory:', walMode: false });
  db.exec(`CREATE TABLE people (id INTEGER PRIMARY KEY, first TEXT, last TEXT, legacy TEXT);
           CREATE INDEX idx_people_last ON people(last);
           CREATE TABLE notes (id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id), body TEXT);`);
  db.run(`INSERT INTO people (first,last,legacy) VALUES ('Ada','Lovelace','x'),('Alan','Turing','y')`);
  db.run(`INSERT INTO notes (person_id, body) VALUES (1,'a'),(2,'b')`);
  return db;
}

describe('rebuildTable (B17)', () => {
  it('drops a column, derives a new one, keeps rows, indexes and referencing tables', () => {
    const db = makeDb();
    const r = rebuildTable(
      db,
      'people',
      `CREATE TABLE people (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, last TEXT)`,
      { copy: { full_name: "first || ' ' || last" } }
    );
    expect(r.rows).toBe(2);
    expect(db.all('SELECT full_name FROM people ORDER BY id').map((x) => x.full_name)).toEqual(['Ada Lovelace', 'Alan Turing']);
    expect(db.all('PRAGMA table_info(people)').map((c) => c.name)).toEqual(['id', 'full_name', 'last']);
    expect(db.get(`SELECT 1 AS x FROM sqlite_master WHERE name = 'idx_people_last'`)).toBeTruthy();
    expect(db.get('SELECT COUNT(*) AS n FROM notes').n).toBe(2);
    expect(Number(db.get('PRAGMA foreign_keys').foreign_keys)).toBe(1);
  });

  it('rolls back completely when the new shape breaks a foreign key', () => {
    const db = makeDb();
    expect(() =>
      rebuildTable(db, 'people', `CREATE TABLE people (id INTEGER PRIMARY KEY, first TEXT, last TEXT)`, { copy: { id: 'id + 100' } })
    ).toThrow(/foreign key/);
    expect(db.all('SELECT id FROM people ORDER BY id').map((x) => x.id)).toEqual([1, 2]);
    expect(db.all('PRAGMA table_info(people)').length).toBe(4);
    expect(db.get(`SELECT 1 AS x FROM sqlite_master WHERE name = 'people__new'`) ?? null).toBe(null);
    expect(Number(db.get('PRAGMA foreign_keys').foreign_keys)).toBe(1);
  });

  it('refuses a statement for another table, a missing table and unsafe names', () => {
    const db = makeDb();
    expect(() => rebuildTable(db, 'people', 'CREATE TABLE other (id INTEGER)')).toThrow(/must start with/);
    expect(() => rebuildTable(db, 'nope', 'CREATE TABLE nope (id INTEGER)')).toThrow(/does not exist/);
    expect(() => rebuildTable(db, 'people; DROP TABLE notes', 'x')).toThrow();
  });
});
