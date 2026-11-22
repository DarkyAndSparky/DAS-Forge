import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteAdapter } from '../src/database/index.js';
import * as auth from '../src/auth/index.js';

const fresh = () => createSqliteAdapter({ file: ':memory:', walMode: false });
const sha1 = (s) => createHash('sha1').update(s).digest('hex').toUpperCase();

describe('asynchronous password policy', () => {
  it('reads the configuration, saves, resets, and refuses bad values like the synchronous store', async () => {
    const db = fresh();
    const p = auth.createPasswordPolicyAsync({ db, config: { minLength: 10 } });
    expect(await p.get()).toMatchObject({ minLength: 10, adminMinLength: 10, profile: 'custom' });
    expect(await p.set({ profile: 'fstec' })).toMatchObject({ profile: 'fstec', requireClasses: 4, historyCount: 12 });
    expect(auth.createPasswordPolicy({ db }).get().profile).toBe('fstec'); // one shared row
    await expect(p.set({ minLength: '14' })).rejects.toThrow(/ADMIN_MIN_LENGTH_INVALID/);
    expect(await p.set({ minLength: '14', adminMinLength: '16' })).toMatchObject({ minLength: 14, adminMinLength: 16 });
    await expect(p.set({ minLength: 3 })).rejects.toThrow(/MIN_LENGTH_INVALID/);
    await expect(p.set({ profile: 'nope' })).rejects.toThrow(/PROFILE_UNKNOWN/);
    expect((await p.reset()).minLength).toBe(10);
  });

  it('a damaged row never weakens the rules', async () => {
    const db = fresh();
    const p = auth.createPasswordPolicyAsync({ db });
    await p.set({ minLength: 12 });
    db.run("UPDATE app_settings SET value = '{\"minLength\":1}' WHERE key = 'password_policy'");
    expect((await p.get()).minLength).toBe(12);
    db.run("UPDATE app_settings SET value = 'garbage' WHERE key = 'password_policy'");
    expect((await p.get()).minLength).toBe(12);
  });

  it('check uses the dictionary; checkFull adds REUSED and LEAKED', async () => {
    const db = fresh();
    const dir = mkdtempSync(join(tmpdir(), 'pw-'));
    const file = join(dir, 'pwned.txt');
    writeFileSync(file, [`${sha1('qp-leaked-1x')}:5`, `${sha1('zzz-other-pass')}:2`].sort().join('\n') + '\n');
    const p = auth.createPasswordPolicyAsync({ db, appName: 'AcmeApp', blocklistFile: file });
    await p.set({ historyCount: 3 });
    expect((await p.check('short')).ok).toBe(false);
    expect((await p.check('xK9#mPq2vL8zRt', { username: 'bob' })).ok).toBe(true);
    expect((await p.check('xK9#AcmeAppq2vL8')).ok).toBe(false); // contains the application name
    await p.dictionary.addWords('Zebra-Mountain-77');
    expect((await p.check('zebra-mountain-77')).ok).toBe(false);
    const u = await auth.createUserAsync(db, { username: 'carl', passwordHash: 'h0' });
    await auth.recordPasswordAsync(db, u.id, 'old-hash');
    const verify = async (hash, plain) => ({ valid: hash === `H(${plain})` });
    const r = await p.checkFull('xK9#mPq2vL8zRt', {}, { userId: u.id, verify, currentHash: 'H(xK9#mPq2vL8zRt)' });
    expect(r.problems).toContain('REUSED');
    const leaked = await p.checkFull('qp-leaked-1x', {}, {});
    expect(leaked.problems).toContain('LEAKED');
  });

  it('expiry follows maxAgeDays', async () => {
    const db = fresh();
    const p = auth.createPasswordPolicyAsync({ db });
    const u = await auth.createUserAsync(db, { username: 'dora', passwordHash: 'h' });
    expect(await p.isExpired(u.id)).toBe(false);
    await p.set({ maxAgeDays: 30 });
    expect(await p.isExpired(u.id)).toBe(false); // stamped on first sight
    db.run("UPDATE users SET password_changed_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [u.id]);
    expect(await p.isExpired(u.id)).toBe(true);
  });
});

describe('asynchronous password dictionary', () => {
  it('adds, skips duplicates and invalid words, removes, and shares the row with the synchronous one', async () => {
    const db = fresh();
    const d = auth.createPasswordDictionaryAsync({ db });
    expect(await d.addWords('alpha-word, beta-word\nbeta-word;ab')).toEqual({ added: 2, skipped: 1, invalid: 1, total: 2 });
    expect(auth.createPasswordDictionary({ db }).words()).toEqual(['alpha-word', 'beta-word']);
    expect(await d.removeWord('ALPHA-word')).toBe(true);
    expect(await d.removeWord('alpha-word')).toBe(false);
    expect(await d.hasWord('beta-word')).toBe(true);
    expect((await d.inspect('beta-word')).custom).toBe(true);
    await expect(d.addWords(Array.from({ length: 5001 }, (_, i) => `word-number-${i}`))).rejects.toThrow(/TOO_MANY_WORDS/);
  });

  it('file layer: refuses bad paths and formats, connects a good file, falls back to the configured one', async () => {
    const db = fresh();
    const dir = mkdtempSync(join(tmpdir(), 'pwd-'));
    const good = join(dir, 'good.txt');
    writeFileSync(good, [`${sha1('aaaa-1')}:1`, `${sha1('bbbb-2')}:2`].sort().join('\n') + '\n');
    const bad = join(dir, 'bad.txt');
    writeFileSync(bad, 'this is not a hash list at all, not even close to one line\n');
    const d = auth.createPasswordDictionaryAsync({ db, configFile: good });
    expect((await d.fileState()).source).toBe('config');
    await expect(d.setFile('relative/path')).rejects.toThrow(/FILE_PATH_INVALID/);
    await expect(d.setFile(join(dir, 'missing'))).rejects.toThrow(/FILE_NOT_FOUND/);
    await expect(d.setFile(bad)).rejects.toThrow(/FILE_FORMAT_INVALID/);
    expect(await d.fileHas('aaaa-1')).toBe(true);
    expect(await d.fileHas('cccc-3')).toBe(false);
    await d.setFile(good);
    expect((await d.fileState())).toMatchObject({ source: 'setting', ok: true });
    await d.clearFile();
    expect((await d.fileState()).source).toBe('config');
  });
});

describe('asynchronous re-sealing of TOTP secrets', () => {
  it('encrypts plaintext, re-encrypts with a new key, leaves current ones, counts', async () => {
    const db = fresh();
    const u = await auth.createUserAsync(db, { username: 'seal', passwordHash: 'h' });
    db.run("INSERT INTO authenticators (user_id, type, status) VALUES (?, 'totp', 'active')", [u.id]);
    db.run("INSERT INTO totp_credentials (authenticator_id, secret) VALUES (1, 'PLAINSECRET')");
    const k1 = 'a'.repeat(20);
    const k2 = 'b'.repeat(20);
    expect(await auth.sealExistingTotpSecretsAsync(db, undefined)).toBe(0);
    expect(await auth.sealExistingTotpSecretsAsync(db, k1)).toBe(1);
    expect(await auth.sealExistingTotpSecretsAsync(db, k1)).toBe(0);
    expect(await auth.sealExistingTotpSecretsAsync(db, [k2, k1])).toBe(1);
    const stored = db.get('SELECT secret FROM totp_credentials').secret;
    expect(stored.startsWith('enc:v2:')).toBe(true); // bound to its row (audit R-03)
    expect(await auth.sealExistingTotpSecretsAsync(db, [k2])).toBe(0);
  });
});
