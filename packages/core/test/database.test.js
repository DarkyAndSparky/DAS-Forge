import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  createSqliteAdapter,
  assertDatabaseAdapter,
  queryByExample,
} from '../src/database/index.js';

describe('createSqliteAdapter (in-memory)', () => {
  let db;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    db.exec(`
      CREATE TABLE assets (
        rowid INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        notes TEXT,
        org TEXT
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('satisfies the DatabaseAdapter contract', () => {
    expect(() => assertDatabaseAdapter(db)).not.toThrow();
  });

  it('runs basic CRUD via run/get/all', () => {
    db.run('INSERT INTO assets (name, notes, org) VALUES (?, ?, ?)', ['Laptop X1', 'spare', 'IT']);
    const row = db.get('SELECT * FROM assets WHERE name = ?', ['Laptop X1']);
    expect(row.name).toBe('Laptop X1');

    db.run('INSERT INTO assets (name, org) VALUES (?, ?)', ['Switch 24p', 'NET']);
    const all = db.all('SELECT * FROM assets ORDER BY rowid');
    expect(all).toHaveLength(2);
  });

  it('commits a successful transaction', () => {
    db.transaction((tx) => {
      tx.run('INSERT INTO assets (name, org) VALUES (?, ?)', ['A', 'IT']);
      tx.run('INSERT INTO assets (name, org) VALUES (?, ?)', ['B', 'IT']);
    });
    expect(db.all('SELECT * FROM assets')).toHaveLength(2);
  });

  it('rolls back a failed transaction', () => {
    expect(() =>
      db.transaction((tx) => {
        tx.run('INSERT INTO assets (name, org) VALUES (?, ?)', ['A', 'IT']);
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(db.all('SELECT * FROM assets')).toHaveLength(0);
  });

  it('queryByExample builds a safe equality lookup', () => {
    db.run('INSERT INTO assets (name, org) VALUES (?, ?)', ['A', 'IT']);
    db.run('INSERT INTO assets (name, org) VALUES (?, ?)', ['B', 'NET']);
    db.run('INSERT INTO assets (name, org) VALUES (?, ?)', ['C', 'IT']);

    const itAssets = db.queryByExample('assets', { org: 'IT' });
    expect(itAssets).toHaveLength(2);
  });

  it('queryByExample rejects unsafe identifiers', () => {
    expect(() => queryByExample(db, 'assets; DROP TABLE assets', {})).toThrow();
    expect(() => db.queryByExample('assets', { 'org = 1 OR 1': 'x' })).toThrow();
  });

  it('createFtsIndex finds rows by full-text match after insert/update/delete', () => {
    const idx = db.createFtsIndex('assets', ['name', 'notes']);

    db.run('INSERT INTO assets (name, notes, org) VALUES (?, ?, ?)', [
      'Dell Latitude',
      'warranty expires 2027',
      'IT',
    ]);
    db.run('INSERT INTO assets (name, notes, org) VALUES (?, ?, ?)', [
      'HP Switch',
      'core network',
      'NET',
    ]);

    let results = db.all(idx.searchSql(), ['Latitude']);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Dell Latitude');

    db.run('UPDATE assets SET notes = ? WHERE name = ?', ['renamed unit', 'HP Switch']);
    results = db.all(idx.searchSql(), ['renamed']);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('HP Switch');

    db.run('DELETE FROM assets WHERE name = ?', ['Dell Latitude']);
    results = db.all(idx.searchSql(), ['Latitude']);
    expect(results).toHaveLength(0);
  });
});

describe('assertDatabaseAdapter', () => {
  it('rejects an object missing required methods', () => {
    expect(() => assertDatabaseAdapter({ run: () => {} })).toThrow(/missing method/);
  });

  it('rejects non-objects', () => {
    expect(() => assertDatabaseAdapter(null)).toThrow();
    expect(() => assertDatabaseAdapter('nope')).toThrow();
  });
});
