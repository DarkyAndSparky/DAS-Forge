import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';

import { acceptUpload, removeUpload } from '../src/files/index.js';
import { storeUpload } from '../src/files/upload-storage.js';
import { createSqliteAdapter, ftsEscape, normalizeLimit, assertSafeIdentifier, queryByExample } from '../src/database/index.js';

/** Audit wave 2b: B08 (FTS safety), B10 (acceptUpload pipeline), B13 (atomic storage, no orphans). */

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngWithTail = Buffer.concat([PNG_HEAD, Buffer.from('IDAT-ish'), Buffer.from('<html>polyglot tail</html>')]);

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'das-upload-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('acceptUpload (B10)', () => {
  const base = () => ({ allowedTypes: ['png', 'jpg', 'svg'], maxBytes: 1024 * 1024, storageDir: dir });

  it('stores the RE-ENCODED bytes, not the uploaded ones (polyglot tail never reaches disk)', async () => {
    const clean = Buffer.concat([PNG_HEAD, Buffer.from('clean-reencoded')]);
    let seenOptions;
    const r = await acceptUpload(pngWithTail, {
      ...base(),
      imageOptions: { maxWidth: 512 },
      reencode: async (buf, opts) => {
        seenOptions = opts;
        return { buffer: clean, format: 'png' };
      },
    });
    expect(readFileSync(r.fullPath).equals(clean)).toBe(true);
    expect(readFileSync(r.fullPath).includes('polyglot')).toBe(false);
    expect(seenOptions).toEqual({ maxWidth: 512 });
    expect(r).toMatchObject({ type: 'png', mime: 'image/png', size: clean.length });
    expect(r.filename).toMatch(/^[0-9a-f-]{36}\.png$/);
  });

  it('a decode failure rejects the upload and writes nothing', async () => {
    await expect(
      acceptUpload(pngWithTail, { ...base(), reencode: async () => { throw new Error('corrupt'); } })
    ).rejects.toThrow(/could not be decoded safely.*corrupt/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('stores under the type actually produced when re-encode converts format', async () => {
    const r = await acceptUpload(pngWithTail, {
      ...base(),
      allowedTypes: ['png', 'jpg'],
      reencode: async () => ({ buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]), format: 'jpeg' }),
    });
    expect(r.type).toBe('jpg');
    expect(r.mime).toBe('image/jpeg');
    expect(r.filename.endsWith('.jpg')).toBe(true);
  });

  it('refuses GIF (no re-encode path) unless explicitly passed through', async () => {
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from('....')]);
    await expect(acceptUpload(gif, { ...base(), allowedTypes: ['gif'] })).rejects.toThrow(/passthroughTypes/);
    const ok = await acceptUpload(gif, { ...base(), allowedTypes: ['gif'], passthroughTypes: ['gif'] });
    expect(ok.type).toBe('gif');
  });

  it('requires maxBytes, allowedTypes and storageDir (no accidental "unlimited")', async () => {
    await expect(acceptUpload(PNG_HEAD, { allowedTypes: ['png'], storageDir: dir })).rejects.toThrow(/maxBytes/);
    await expect(acceptUpload(PNG_HEAD, { maxBytes: 10, storageDir: dir })).rejects.toThrow(/allowedTypes/);
    await expect(acceptUpload(PNG_HEAD, { maxBytes: 10, allowedTypes: ['png'] })).rejects.toThrow(/storageDir/);
    await expect(acceptUpload('not a buffer', base())).rejects.toThrow(/Buffer/);
  });

  it('rejects oversize, unknown content, and disallowed types before writing anything', async () => {
    await expect(acceptUpload(pngWithTail, { ...base(), maxBytes: 5 })).rejects.toThrow(/exceeds maximum/);
    await expect(acceptUpload(Buffer.from('plain text'), base())).rejects.toThrow(/Could not determine/);
    await expect(acceptUpload(pngWithTail, { ...base(), allowedTypes: ['pdf'] })).rejects.toThrow(/not allowed/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('SVG is sanitized (script removed) and stored', async () => {
    const ok = await acceptUpload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>'), base());
    expect(ok.type).toBe('svg');
    expect(readFileSync(ok.fullPath, 'utf8')).not.toMatch(/<script/i);
  });
});

describe('storage (B13)', () => {
  it('writes atomically with owner-only permissions and leaves no .tmp', () => {
    const { fullPath } = storeUpload(Buffer.from('x'), dir, 'png');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    if (process.platform !== 'win32') expect(statSync(fullPath).mode & 0o777).toBe(0o600);
  });

  it('removeUpload deletes only names storeUpload could have generated', () => {
    const { filename, fullPath } = storeUpload(Buffer.from('x'), dir, 'png');
    expect(removeUpload(dir, '../../etc/passwd')).toBe(false);
    expect(removeUpload(dir, 'logo.png')).toBe(false);
    expect(removeUpload(dir, null)).toBe(false);
    expect(existsSync(fullPath)).toBe(true);
    expect(removeUpload(dir, filename)).toBe(true);
    expect(existsSync(fullPath)).toBe(false);
    expect(removeUpload(dir, filename)).toBe(false); // already gone
  });
});

describe('FTS and query helpers (B08)', () => {
  let db, fts;
  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, body TEXT)');
    db.run('INSERT INTO notes (title, body) VALUES (?, ?)', ['C++ guide', 'pointers and foo-bar patterns']);
    db.run('INSERT INTO notes (title, body) VALUES (?, ?)', ['Рецепт борща', 'свёкла капуста мясо']);
    fts = db.createFtsIndex('notes', ['title', 'body'], { rowidColumn: 'id' });
  });
  afterEach(() => db.close());

  const search = (text, limit) => {
    const q = fts.escapeQuery(text);
    return q === null ? [] : db.all(fts.searchSql(limit), [q]);
  };

  it('an index created over existing rows is filled automatically; rebuild() stays safe to repeat', () => {
    expect(search('guide')).toHaveLength(1);
    fts.rebuild();
    fts.rebuild();
    expect(search('guide')).toHaveLength(1);
  });

  it('special characters are searched literally instead of raising fts5 syntax errors', () => {
    fts.rebuild();
    for (const text of ['C++', 'foo-bar', 'a:b', 'NEAR(', '"unbalanced', 'title:guide', '*', 'AND OR NOT']) {
      expect(() => search(text)).not.toThrow();
    }
    expect(search('foo-bar')).toHaveLength(1);
    expect(search('guide pointers')).toHaveLength(1); // words are AND-ed
    expect(search('борща')).toHaveLength(1);
  });

  it('empty / whitespace input yields no query instead of an error', () => {
    expect(ftsEscape('   ')).toBeNull();
    expect(ftsEscape(undefined)).toBeNull();
    expect(search('')).toEqual([]);
  });

  it('rejects unsafe identifiers in createFtsIndex', () => {
    expect(() => db.createFtsIndex('notes; DROP TABLE notes', ['title'])).toThrow(/Unsafe table/);
    expect(() => db.createFtsIndex('notes', ['title, body) --'])).toThrow(/Unsafe column/);
    expect(() => db.createFtsIndex('notes', ['title'], { rowidColumn: "id'" })).toThrow(/Unsafe rowid/);
    expect(() => assertSafeIdentifier(42)).toThrow(/Unsafe/);
  });

  it('normalizeLimit never yields NaN, negative or unbounded values', () => {
    expect(normalizeLimit('abc')).toBe(20);
    expect(normalizeLimit(-5)).toBe(20);
    expect(normalizeLimit(0)).toBe(20);
    expect(normalizeLimit(7.9)).toBe(7);
    expect(normalizeLimit(10 ** 9)).toBe(1000);
    expect(db.all(fts.searchSql('abc'), ['"x"'])).toEqual([]); // valid SQL with a junk limit
  });

  it('queryByExample normalizes a hostile limit', () => {
    expect(queryByExample(db, 'notes', {}, { limit: -1 })).toHaveLength(2);
    expect(queryByExample(db, 'notes', {}, { limit: 'abc' })).toHaveLength(2);
    expect(queryByExample(db, 'notes', {}, { limit: 1 })).toHaveLength(1);
  });
});
