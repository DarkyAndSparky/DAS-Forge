import { describe, it, expect } from 'vitest';
import { createSqliteAdapter, createFtsIndexAsync } from '../src/database/index.js';

describe('createFtsIndexAsync on SQLite', () => {
  it('gives the same index as createFtsIndex', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, title TEXT)');
    db.run('INSERT INTO t (title) VALUES (?)', ['Ноутбук Dell']);
    const fts = await createFtsIndexAsync(db, 't', ['title'], { rowidColumn: 'id' });
    expect(db.all(fts.searchSql(), [fts.escapeQuery('dell')]).length).toBe(1);
    db.close();
  });
  it('asks for the synchronous adapter when given something else', async () => {
    await expect(createFtsIndexAsync({ dialect: 'sqlite' }, 't', ['title'])).rejects.toThrow(/synchronous/);
  });
});
