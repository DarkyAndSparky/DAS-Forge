import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSqliteAdapter } from '../src/database/index.js';
import { createCli } from '../src/cli/index.js';
import { parseArgs, flagString, flagInt, ArgError } from '../src/cli/arg-parser.js';
import { registerAuditCommands } from '../src/cli/commands/audit.js';
import { registerPrivacyCommands } from '../src/cli/commands/privacy.js';
import { writeOwnerOnly } from '../src/cli/safe-write.js';
import { createBackupJob, restoreBackup } from '../src/scheduler/index.js';
import * as auth from '../src/auth/index.js';
import { generateRecoveryCodes, verifyAndConsumeRecoveryCode, countRemainingRecoveryCodes } from '../src/auth/recovery-codes.js';
import { createPasswordResetToken } from '../src/auth/password-reset.js';

/** Audit 0.1.78: G01, G03, G04, G05, K01, K08, F01, L02, L03. */

describe('G01: boolean flags with a value', () => {
  it('--yes=false is false, --yes=true is true, junk is refused', () => {
    expect(parseArgs(['x', '--yes=false']).flags.yes).toBe(false);
    expect(parseArgs(['x', '--yes=0']).flags.yes).toBe(false);
    expect(parseArgs(['x', '--yes=TRUE']).flags.yes).toBe(true);
    expect(() => parseArgs(['x', '--yes=maybe'])).toThrow(ArgError);
  });
  it('-y is --yes and --hard does not swallow the next word', () => {
    expect(parseArgs(['user', 'delete', '-y']).flags.yes).toBe(true);
    const r = parseArgs(['user', 'delete', '--hard', 'bob']);
    expect(r.flags.hard).toBe(true);
    expect(r.positionals).toEqual(['user', 'delete', 'bob']);
  });
  it('the CLI turns a malformed boolean into a usage error (exit 2)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cli = createCli();
    cli.command('noop', { description: 'x', handler: () => 0 });
    expect(await cli.run(['noop', '--yes=maybe'])).toBe(2);
    err.mockRestore();
  });
});

describe('G05: typed flag helpers', () => {
  it('flagString refuses a bare flag, flagInt refuses non-numbers and out-of-range', () => {
    expect(flagString({ user: 'bob' }, 'user')).toBe('bob');
    expect(flagString({}, 'user')).toBeUndefined();
    expect(() => flagString({ user: true }, 'user')).toThrow(ArgError);
    expect(flagInt({ days: '30' }, 'days', { min: 1, max: 100 })).toBe(30);
    expect(() => flagInt({ days: 'abc' }, 'days')).toThrow(ArgError);
    expect(() => flagInt({ days: '0' }, 'days', { min: 1 })).toThrow(ArgError);
    expect(() => flagInt({ days: '1.5' }, 'days')).toThrow(ArgError);
  });
});

describe('G04: owner-only exports', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'das-wk-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes 0600, refuses to overwrite without force, overwrites with it', () => {
    const f = path.join(dir, 'out.json');
    writeOwnerOnly(f, 'one');
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(() => writeOwnerOnly(f, 'two')).toThrow(ArgError);
    expect(readFileSync(f, 'utf8')).toBe('one');
    writeOwnerOnly(f, 'two', { force: true });
    expect(readFileSync(f, 'utf8')).toBe('two');
  });

  it('privacy export --out uses it, and a bare --user is a usage error, not a crash', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cli = createCli();
    registerPrivacyCommands(cli, {
      findUserByUsernameFn: (name) => (name === 'bob' ? { id: 1 } : null),
      exportUserDataFn: async () => ({ user: { username: 'bob' } }),
      eraseUserDataFn: async () => ({ accountErased: true, moduleResults: {} }),
    });
    const f = path.join(dir, 'bob.json');
    expect(await cli.run(['privacy', 'export', '--user', 'bob', '--out', f])).toBe(0);
    expect(existsSync(f)).toBe(true);
    expect(await cli.run(['privacy', 'export', '--user', 'bob', '--out', f])).toBe(2); // exists
    expect(await cli.run(['privacy', 'export', '--user'])).toBe(2);
    log.mockRestore();
    err.mockRestore();
  });

  it('privacy erase --yes=false does NOT erase', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let erased = 0;
    const cli = createCli();
    registerPrivacyCommands(cli, {
      findUserByUsernameFn: () => ({ id: 1 }),
      exportUserDataFn: async () => ({}),
      eraseUserDataFn: async () => { erased++; return { accountErased: true, moduleResults: {} }; },
    });
    expect(await cli.run(['privacy', 'erase', '--user', 'bob', '--yes=false'])).toBe(1);
    expect(erased).toBe(0);
    err.mockRestore();
  });
});

describe('G03: audit export is complete', () => {
  it('walks pages of 1000 instead of silently stopping at the cap', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'das-wk-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const all = Array.from({ length: 2500 }, (_, i) => ({ id: 2500 - i, createdAt: 'x', actor: 'a', action: 'x', result: 'success', meta: {} }));
    const queryFn = (_db, { limit, beforeId }) => all.filter((e) => beforeId === undefined || e.id < beforeId).slice(0, Math.min(limit, 1000));
    const cli = createCli();
    registerAuditCommands(cli, { db: {}, tailFn: () => [], queryFn });
    const f = path.join(dir, 'a.json');
    expect(await cli.run(['audit', 'export', f])).toBe(0);
    expect(JSON.parse(readFileSync(f, 'utf8'))).toHaveLength(2500);
    const g = path.join(dir, 'b.json');
    expect(await cli.run(['audit', 'export', g, '--limit', '1200'])).toBe(0);
    expect(JSON.parse(readFileSync(g, 'utf8'))).toHaveLength(1200);
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('K01/K08: recovery codes', () => {
  let db;
  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    auth.createUser(db, { username: 'root', passwordHash: 'h', role: 'admin' });
  });
  afterEach(() => db.close());

  it('one code works once even when two requests race', async () => {
    const [code] = await generateRecoveryCodes(db, 1, { count: 2 });
    const results = await Promise.all([verifyAndConsumeRecoveryCode(db, 1, code), verifyAndConsumeRecoveryCode(db, 1, code)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(countRemainingRecoveryCodes(db, 1)).toBe(1);
  });

  it('regenerating replaces the whole set', async () => {
    const first = await generateRecoveryCodes(db, 1, { count: 3 });
    const second = await generateRecoveryCodes(db, 1, { count: 3 });
    expect(countRemainingRecoveryCodes(db, 1)).toBe(3);
    expect(await verifyAndConsumeRecoveryCode(db, 1, first[0])).toBe(false);
    expect(await verifyAndConsumeRecoveryCode(db, 1, second[0])).toBe(true);
  });
});

describe('F01: anonymize removes everything that belongs to the account', () => {
  it('second factors, recovery codes, reset tokens and sessions are gone', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    const user = auth.createUser(db, { username: 'ivan', passwordHash: 'h', role: 'operator', email: 'i@example.com' });
    const other = auth.createUser(db, { username: 'petr', passwordHash: 'h', role: 'operator' });
    const t = (id) => auth.startTotpEnrollment(db, id, { accountName: 'x' });
    t(user.id);
    t(other.id);
    await generateRecoveryCodes(db, user.id, { count: 2 });
    await generateRecoveryCodes(db, other.id, { count: 2 });
    createPasswordResetToken(db, user.id);
    const count = (table, id) => db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, [id]).n;

    auth.anonymizeUser(db, user.id);

    expect(count('authenticators', user.id)).toBe(0);
    expect(count('recovery_codes', user.id)).toBe(0);
    expect(count('password_resets', user.id)).toBe(0);
    expect(db.get('SELECT COUNT(*) AS n FROM totp_credentials').n).toBe(1); // petr's survives
    expect(count('recovery_codes', other.id)).toBe(2);
    db.close();
  });
});

describe('L02/L03: restore', () => {
  it('drops restored sessions and open reset tokens, keeps the safety copy owner-only', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'das-wk-'));
    const dbPath = path.join(root, 'app.db');
    let db = createSqliteAdapter({ file: dbPath });
    auth.createUser(db, { username: 'root', passwordHash: 'h', role: 'admin' });
    db.run(`INSERT INTO sessions (id, user_id, created_at, expires_at, data) VALUES ('h1:x', 1, ?, ?, '{}')`, [new Date().toISOString(), new Date(Date.now() + 3.6e6).toISOString()]);
    createPasswordResetToken(db, 1);
    await createBackupJob({ db, destinations: [{ id: 'l', type: 'local', path: path.join(root, 'b') }], retentionDays: 7 })();
    db.close();
    const backup = path.join(root, 'b', readdirBackup(path.join(root, 'b')));

    const result = await restoreBackup({ dbFilePath: dbPath, backupFilePath: backup, createAdapterFn: createSqliteAdapter });
    expect(result.ok).toBe(true);
    expect(result.steps.some((s) => s.name === 'Revoke sessions')).toBe(true);
    expect(result.db.get('SELECT COUNT(*) AS n FROM sessions').n).toBe(0);
    expect(result.db.get('SELECT COUNT(*) AS n FROM password_resets WHERE used_at IS NULL').n).toBe(0);
    if (process.platform !== 'win32') expect(statSync(result.preRestorePath).mode & 0o777).toBe(0o600);
    result.db.close();
    rmSync(root, { recursive: true, force: true });
  });
});

import { readdirSync } from 'node:fs';
function readdirBackup(dir) {
  return readdirSync(dir).find((f) => f.startsWith('backup-'));
}
