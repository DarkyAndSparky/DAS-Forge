import { describe, it, expect, afterAll } from 'vitest';
import { openTestDb, pgConfigured } from './support/pg-test-db.js';
import { createFtsIndexAsync, tsEscape } from '@das-forge/core/database';

describe('tsEscape', () => {
  it('quotes words, makes prefixes, ignores punctuation and query operators', () => {
    expect(tsEscape('Ноутбук Dell')).toBe("'Ноутбук' & 'Dell'");
    expect(tsEscape('ноут', { prefix: true })).toBe("'ноут':*");
    expect(tsEscape("a' | b & !c:*")).toBe("'a' & 'b' & 'c'");
    expect(tsEscape('свёкла', { foldYo: true })).toBe("'свекла'");
    expect(tsEscape('  ++ -- ')).toBeNull();
  });
});

describe.skipIf(!pgConfigured)('full-text search on PostgreSQL', () => {
  let db;
  afterAll(async () => { await db?.close(); });

  it('finds words and prefixes in several columns, ignores hostile input, follows updates and deletes', async () => {
    db = await openTestDb();
    await db.exec('CREATE TABLE assets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, note TEXT)');
    await db.run('INSERT INTO assets (name, note) VALUES (?, ?)', ['Ноутбук Dell', 'бухгалтерия']);
    await db.run('INSERT INTO assets (name, note) VALUES (?, ?)', ['Принтер HP', 'склад, ноутбуки рядом']);
    await db.run('INSERT INTO assets (name, note) VALUES (?, ?)', ['Монитор', null]);
    const fts = await createFtsIndexAsync(db, 'assets', ['name', 'note']);
    await createFtsIndexAsync(db, 'assets', ['name', 'note']); // second call: nothing breaks
    expect((await fts.searchAsync('dell')).map((r) => r.name)).toEqual(['Ноутбук Dell']);
    expect((await fts.searchAsync('ноутбук', { prefix: true })).length).toBe(2);
    expect((await fts.searchAsync('ноутбук')).length).toBe(1);
    expect(await fts.searchAsync("'; DROP TABLE assets; --")).toEqual([]);
    expect(await fts.searchAsync('!!!')).toEqual([]);
    await db.run("UPDATE assets SET name = 'Сканер' WHERE name = 'Монитор'");
    expect((await fts.searchAsync('сканер')).length).toBe(1);
    await db.run("DELETE FROM assets WHERE name = 'Сканер'");
    expect(await fts.searchAsync('сканер')).toEqual([]);
    expect((await db.all(fts.searchSql(5), [fts.escapeQuery('hp'), fts.escapeQuery('hp')])).length).toBe(1);
    expect((await db.all("SELECT indexname FROM pg_indexes WHERE tablename = 'assets' AND indexname = 'assets_fts'")).length).toBe(1);
  });

  it('rejects wrong arguments', async () => {
    db ??= await openTestDb();
    await expect(createFtsIndexAsync(db, 'assets', [])).rejects.toThrow(/non-empty/);
    await expect(createFtsIndexAsync(db, 'assets; x', ['name'])).rejects.toThrow();
    await expect(createFtsIndexAsync(db, 'assets', ['name'], { config: "simple'); --" })).rejects.toThrow(/configuration/);
  });
});
