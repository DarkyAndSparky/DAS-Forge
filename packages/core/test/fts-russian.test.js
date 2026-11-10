import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSqliteAdapter, ftsEscape, foldYo } from '../src/database/index.js';

describe('FTS for Russian text (audit B09)', () => {
  let db;
  let fts;
  const search = (text, options) => {
    const q = fts.escapeQuery(text, options);
    return q === null ? [] : db.all(fts.searchSql(), [q]).map((r) => r.title);
  };

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, body TEXT, flag INTEGER DEFAULT 0)');
    db.run('INSERT INTO notes (title, body) VALUES (?, ?)', ['Ноутбуки Lenovo', 'Список ноутбуков для офиса']);
    db.run('INSERT INTO notes (title, body) VALUES (?, ?)', ['Свёкла', 'Всё про ёлку и свёклу']);
    db.run('INSERT INTO notes (title, body) VALUES (?, ?)', ['Принтер', 'HP LaserJet']);
    fts = db.createFtsIndex('notes', ['title', 'body'], { rowidColumn: 'id' });
  });
  afterEach(() => db.close());

  it('case does not matter for Cyrillic', () => {
    expect(search('НОУТБУКИ')).toEqual(['Ноутбуки Lenovo']);
    expect(search('lenovo')).toEqual(['Ноутбуки Lenovo']);
  });

  it('SQLite itself does not fold ё/е (documented limit)', () => {
    expect(search('свекла')).toEqual([]);
    expect(search('свёкла')).toEqual(['Свёкла']);
  });

  it('foldYo on a shadow column + on the query makes ё and е interchangeable', () => {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, name_search TEXT)');
    for (const name of ['Свёкла', 'Ёлка', 'Дерево']) db.run('INSERT INTO items (name, name_search) VALUES (?, ?)', [name, foldYo(name)]);
    const idx = db.createFtsIndex('items', ['name_search'], { rowidColumn: 'id' });
    const find = (text) => db.all(idx.searchSql(), [idx.escapeQuery(text, { foldYo: true })]).map((r) => r.name);
    expect(find('свекла')).toEqual(['Свёкла']);
    expect(find('СВЁКЛА')).toEqual(['Свёкла']);
    expect(find('елка')).toEqual(['Ёлка']);
    expect(find('ёлка')).toEqual(['Ёлка']);
    expect(foldYo('Ёжик ёж')).toBe('Ежик еж');
  });

  it('an exact word does not match other word forms; prefix mode does', () => {
    expect(search('ноутбук')).toEqual([]);
    expect(search('ноутбук', { prefix: true })).toEqual(['Ноутбуки Lenovo']);
    expect(search('ноутб', { prefix: true })).toEqual(['Ноутбуки Lenovo']);
  });

  it('ftsEscape builds quoted prefix terms and still neutralises special characters', () => {
    expect(ftsEscape('abc def', { prefix: true })).toBe('"abc"* "def"*');
    expect(ftsEscape('a"b', { prefix: true })).toBe('"a""b"*');
    expect(ftsEscape('  ', { prefix: true })).toBeNull();
    expect(() => search('C++ NEAR( "x', { prefix: true })).not.toThrow();
  });

  it('an index created over existing rows works at once (no manual rebuild)', () => {
    expect(search('принтер')).toEqual(['Принтер']);
  });

  it('updating a column that is NOT indexed leaves the index alone; updating an indexed one re-indexes', () => {
    db.run('UPDATE notes SET flag = 1 WHERE id = 3');
    expect(search('принтер')).toEqual(['Принтер']);
    db.run("UPDATE notes SET title = 'Сканер' WHERE id = 3");
    expect(search('принтер')).toEqual([]);
    expect(search('сканер')).toEqual(['Сканер']);
    db.run('DELETE FROM notes WHERE id = 3');
    expect(search('сканер')).toEqual([]);
  });

  it('the update trigger fires only for indexed columns', () => {
    const sql = db.get(`SELECT sql FROM sqlite_master WHERE name = 'notes_au'`).sql;
    expect(sql).toMatch(/AFTER UPDATE OF title, body ON notes/);
  });

  it('custom tokenizer and prefix indexes are accepted; unsafe values are refused', () => {
    db.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY, title TEXT)');
    db.run("INSERT INTO docs (title) VALUES ('Café')");
    const plain = db.createFtsIndex('docs', ['title'], { rowidColumn: 'id', tokenize: 'unicode61 remove_diacritics 0', prefixLengths: [2, 3] });
    expect(db.all(plain.searchSql(), [plain.escapeQuery('cafe')])).toEqual([]);
    expect(db.all(plain.searchSql(), [plain.escapeQuery('café')])).toHaveLength(1);
    expect(() => db.createFtsIndex('docs', ['title'], { rowidColumn: 'id', tokenize: "x'); DROP TABLE docs; --" })).toThrow(/tokenize/);
    expect(() => db.createFtsIndex('docs', ['title'], { rowidColumn: 'id', prefixLengths: [0] })).toThrow(/prefixLengths/);
  });
});
