import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSqliteAdapter } from '../src/database/index.js';
import { createPasswordDictionary, PasswordDictionaryError, normalizeWord, MAX_CUSTOM_WORDS } from '../src/auth/password-dictionary.js';
import { BUILTIN_WORDS, dictionaryCandidates, matchesDictionary } from '../src/auth/password-words.js';
import { checkPasswordPolicy } from '../src/auth/password-policy.js';
import { createPasswordPolicy } from '../src/auth/password-policy-store.js';
import { createAdmin } from '../src/admin/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { query } from '../src/audit/index.js';

const db0 = () => createSqliteAdapter({ file: ':memory:' });
const sha = (p) => createHash('sha1').update(p).digest('hex').toUpperCase();
function listFile(passwords, { sorted = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pwdict-'));
  const file = join(dir, 'pw.txt');
  let lines = passwords.map((p) => `${sha(p)}:3`);
  if (sorted) lines = lines.sort();
  writeFileSync(file, `${lines.join('\n')}\n`);
  return { dir, file };
}

describe('built-in password words', () => {
  it('is a fixed list of lower-case, unique words', () => {
    expect(BUILTIN_WORDS.length).toBeGreaterThan(300);
    expect(new Set(BUILTIN_WORDS).size).toBe(BUILTIN_WORDS.length);
    expect(Object.isFrozen(BUILTIN_WORDS)).toBe(true);
    expect(BUILTIN_WORDS.every((w) => w === w.toLowerCase())).toBe(true);
  });

  it('catches the word under the usual disguises', () => {
    for (const p of ['password', 'PASSWORD', 'Password2024!', 'P@ssw0rd', '!!Qwerty12345', 'Привет123', 'ghbdtn1']) expect(matchesDictionary(p), p).toBe(true);
  });

  it('lets a good password through', () => {
    for (const p of ['xK9#mPq2vL7w', 'correct horse battery staple', 'Tr0ub4dor&3']) expect(matchesDictionary(p), p).toBe(false);
  });

  it('works on long and empty input without trouble', () => {
    expect(dictionaryCandidates('')).toEqual([]);
    expect(dictionaryCandidates('a'.repeat(5000))).toEqual([]);
    expect(matchesDictionary(undefined)).toBe(false);
  });

  it('is used by the policy as COMMON, together with extra words', () => {
    expect(checkPasswordPolicy('Password2024!', { minLength: 12 }).problems).toContain('COMMON');
    expect(checkPasswordPolicy('Acme-Corp-2026', { minLength: 12 }).problems).not.toContain('COMMON');
    expect(checkPasswordPolicy('Acme-Corp-2026', { minLength: 12, words: ['acme-corp'] }).problems).toContain('COMMON');
  });
});

describe('own words', () => {
  it('adds, normalizes, counts and removes', () => {
    const d = createPasswordDictionary({ db: db0() });
    expect(d.words()).toEqual([]);
    expect(d.addWords('Acme-Corp, ab,\nzzzz-yyyy\n  ')).toEqual({ added: 2, skipped: 0, invalid: 1, total: 2 });
    expect(d.addWords(['ACME-CORP', 'newword'])).toMatchObject({ added: 1, skipped: 1 });
    expect(d.words()).toEqual(['acme-corp', 'newword', 'zzzz-yyyy']);
    expect(d.hasWord('Acme-Corp2026!')).toBe(true);
    expect(d.removeWord('Newword')).toBe(true);
    expect(d.removeWord('Newword')).toBe(false);
    expect(d.hasWord('newword')).toBe(false);
  });

  it('refuses control characters and unreasonable sizes; a damaged row reads as empty', () => {
    expect(normalizeWord('foo\u0000bar')).toBeNull();
    expect(normalizeWord('abc')).toBeNull();
    expect(normalizeWord('x'.repeat(129))).toBeNull();
    expect(normalizeWord(5)).toBeNull();
    const db = db0();
    const d = createPasswordDictionary({ db });
    const many = Array.from({ length: MAX_CUSTOM_WORDS + 1 }, (_, i) => `word${String(i).padStart(6, '0')}`);
    expect(() => d.addWords(many)).toThrow(PasswordDictionaryError);
    expect(d.words()).toEqual([]);
    d.addWords('abcdef');
    db.run(`UPDATE app_settings SET value = ? WHERE key = 'password_custom_words'`, ['{"x":1}']);
    expect(d.words()).toEqual([]);
  });
});

describe('leaked-password file', () => {
  it('is checked before it is connected, then used, and can be dropped', async () => {
    const { file } = listFile(['hunter2', 'qp-leaked-1x', 'letmein99']);
    const d = createPasswordDictionary({ db: db0() });
    expect(await d.fileState()).toMatchObject({ path: null, ok: false });
    expect(await d.fileHas('hunter2')).toBe(false);
    expect((await d.setFile(file)).size).toBeGreaterThan(40);
    expect(await d.fileState()).toMatchObject({ path: file, source: 'setting', ok: true });
    expect(await d.fileHas('hunter2')).toBe(true);
    expect(await d.fileHas('not-in-file')).toBe(false);
    expect(await d.inspect('qp-leaked-1x')).toEqual({ builtin: false, custom: false, file: true });
    expect(await d.inspect('hunter2')).toMatchObject({ builtin: true, file: true }); // "hunter" is in the built-in list as well
    d.clearFile();
    expect(await d.fileState()).toMatchObject({ path: null, ok: false });
  });

  it('falls back to the configured file, and the setting wins over it', async () => {
    const a = listFile(['aaaaaaa1']);
    const b = listFile(['bbbbbbb2']);
    const d = createPasswordDictionary({ db: db0(), configFile: a.file });
    expect(await d.fileState()).toMatchObject({ source: 'config', ok: true });
    expect(await d.fileHas('aaaaaaa1')).toBe(true);
    await d.setFile(b.file);
    expect(await d.fileHas('aaaaaaa1')).toBe(false);
    expect(await d.fileHas('bbbbbbb2')).toBe(true);
  });

  it('refuses a bad path, a missing file and a file that is not a sorted hash list', async () => {
    const d = createPasswordDictionary({ db: db0() });
    const code = async (p) => { try { await d.setFile(p); return 'ok'; } catch (e) { return e.code; } };
    expect(await code('relative.txt')).toBe('FILE_PATH_INVALID');
    expect(await code('/tmp/../etc/\nx')).toBe('FILE_PATH_INVALID');
    expect(await code(42)).toBe('FILE_PATH_INVALID');
    expect(await code('/nonexistent/pw.txt')).toBe('FILE_NOT_FOUND');
    expect(await code(tmpdir())).toBe('FILE_NOT_FOUND');
    const dir = mkdtempSync(join(tmpdir(), 'pwdict-'));
    writeFileSync(join(dir, 'text.txt'), 'this is just text\nnot hashes\n');
    expect(await code(join(dir, 'text.txt'))).toBe('FILE_FORMAT_INVALID');
    writeFileSync(join(dir, 'tiny.txt'), 'AB\n');
    expect(await code(join(dir, 'tiny.txt'))).toBe('FILE_FORMAT_INVALID');
    const unsorted = listFile(['one11111', 'two22222', 'three333', 'four4444'], { sorted: false });
    const lines = ['one11111', 'two22222', 'three333', 'four4444'].map((p) => `${sha(p)}:1`).sort().reverse();
    writeFileSync(unsorted.file, `${lines.join('\n')}\n`);
    expect(await code(unsorted.file)).toBe('FILE_FORMAT_INVALID');
    expect(await d.fileState()).toMatchObject({ path: null });
  });
});

describe('the policy uses all three layers', () => {
  it('check() refuses an own word as COMMON at once; checkFull() refuses a file hit as LEAKED', async () => {
    const db = db0();
    const policy = createPasswordPolicy({ db, config: {}, appName: 'Workshop' });
    expect(policy.check('Acme-Corp-2026').problems).not.toContain('COMMON');
    policy.dictionary.addWords('acme-corp');
    expect(policy.check('Acme-Corp-2026').problems).toContain('COMMON');
    const { file } = listFile(['Zx9-leaked-secret-1']);
    await policy.dictionary.setFile(file);
    expect((await policy.checkFull('Zx9-leaked-secret-1')).problems).toContain('LEAKED');
    expect((await policy.checkFull('Zx9-fresh-secret-22')).ok).toBe(true);
  });
});

describe('admin block "Password dictionary"', () => {
  function setup() {
    const db = db0();
    ensureAuthTables(db);
    const policy = createPasswordPolicy({ db, config: {}, appName: 'Workshop' });
    const routes = {};
    const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
    const requireAuth = () => (req, res, next) => (req.user ? next() : res.status(401).end());
    const requirePermission = (perm) => (req, res, next) => ((req.user.permissions ?? []).includes(perm) ? next() : res.status(403).end());
    createAdmin({ db, passwordPolicy: policy, userManagement: { authProvider: { hashPassword: async (p) => p }, roles: ['admin'], adminRole: 'admin' } }).mount(app, { requireAuth, requirePermission });
    return { db, policy, routes };
  }
  const admin = { id: 1, username: 'root', permissions: ['admin.access'] };
  function call(chain, req) {
    return new Promise((resolve) => {
      req.on ??= function (ev, cb) { if (ev === 'end') cb(); return this; };
      req.headers ??= {};
      const res = { code: 200, body: '', locals: { cspNonce: req.nonce }, set() { return this; }, type() { return this; }, status(c) { this.code = c; return this; } };
      res.end = () => { resolve(res); return res; };
      res.send = (b) => { res.body = b; resolve(res); return res; };
      res.redirect = (c, loc) => { res.code = c; res.location = loc; resolve(res); return res; };
      let i = 0;
      const next = () => { const h = chain[i++]; if (h) Promise.resolve(h(req, res, next)).catch((e) => { res.body = String(e); resolve(res); }); };
      next();
    });
  }
  const post = (routes, path, body) => call(routes[`POST /admin/password-policy/dictionary/${path}`], { user: admin, body });

  it('shows the block, adds and removes words with audit entries', async () => {
    const { db, policy, routes } = setup();
    let page = await call(routes['GET /admin/password-policy'], { user: admin, query: {} });
    expect(page.body).toContain('id="dictionary"');
    let r = await post(routes, 'add', { words: 'Acme-Corp, zzzz-yyyy, ab' });
    expect(r.location).toBe('/admin/password-policy?msg=ok&add=2&skip=0&inv=1#dictionary');
    expect(policy.dictionary.words()).toEqual(['acme-corp', 'zzzz-yyyy']);
    expect(query(db, { action: 'admin.passworddict.words_add' }).length).toBe(1);
    page = await call(routes['GET /admin/password-policy'], { user: admin, query: {} });
    expect(page.body).toContain('data-paged="dict-words"');
    expect(page.body).toContain('acme-corp');
    r = await post(routes, 'add', { words: 'ab' });
    expect(r.location).toContain('msg=bad&e=WORD_INVALID');
    r = await post(routes, 'remove', { word: 'acme-corp' });
    expect(r.code).toBe(303);
    expect(policy.dictionary.words()).toEqual(['zzzz-yyyy']);
    expect(query(db, { action: 'admin.passworddict.words_remove' }).length).toBe(1);
  });

  it('connects and drops a file; a bad file is reported', async () => {
    const { db, policy, routes } = setup();
    const { file } = listFile(['hunter2']);
    let r = await post(routes, 'file', { path: file });
    expect(r.location).toBe('/admin/password-policy?msg=ok#dictionary');
    expect(query(db, { action: 'admin.passworddict.file_set' }).length).toBe(1);
    const page = await call(routes['GET /admin/password-policy'], { user: admin, query: {} });
    expect(page.body).toContain(file);
    r = await post(routes, 'file', { path: 'relative' });
    expect(r.location).toContain('e=FILE_PATH_INVALID');
    r = await post(routes, 'file-clear', {});
    expect(r.code).toBe(303);
    expect((await policy.dictionary.fileState()).path).toBe(null);
    expect(query(db, { action: 'admin.passworddict.file_clear' }).length).toBe(1);
  });

  it('checking a password puts only flags into the redirect and nothing into the audit trail', async () => {
    const { db, routes } = setup();
    const r = await post(routes, 'check', { password: 'Password2024!' });
    expect(r.location).toBe('/admin/password-policy?chk=1&b=1&c=0&f=-#dictionary');
    expect(r.location).not.toContain('Password');
    const r2 = await post(routes, 'check', { password: 'xK9#mPq2vL7w' });
    expect(r2.location).toContain('b=0');
    const all = query(db, {});
    expect(JSON.stringify(all)).not.toContain('Password2024');
    const page = await call(routes['GET /admin/password-policy'], { user: admin, query: { chk: '1', b: '1', c: '0', f: '-' } });
    expect(page.body).toContain('role="status"');
  });
});
