import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSqliteAdapter } from '../src/database/index.js';
import { firstRunBootstrap, writeBootstrapCredentials, removeBootstrapCredentialsIfChanged, watchBootstrapCredentials, bootstrapPrintAllowed } from '../src/auth/bootstrap.js';
import { updatePasswordHash, findUserByUsername } from '../src/auth/users.js';
import { hashPassword } from '../src/auth/password.js';

describe('first-run credentials file', () => {
  let db; let dir; let file; let boot;
  beforeEach(async () => {
    db = createSqliteAdapter({ file: ':memory:' });
    dir = mkdtempSync(path.join(tmpdir(), 'das-boot-'));
    file = path.join(dir, 'first-run-admin.txt');
    boot = await firstRunBootstrap(db, { argon2Options: { memoryCost: 1024, timeCost: 1, parallelism: 1 } });
    writeBootstrapCredentials(file, boot);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const changePassword = async () => {
    const u = findUserByUsername(db, 'admin');
    updatePasswordHash(db, u.id, await hashPassword('A-new-Str0ng-passphrase-42', { memoryCost: 1024, timeCost: 1, parallelism: 1 }), { clearMustChange: true });
  };

  it('stays while the temporary password has not been changed', () => {
    expect(removeBootstrapCredentialsIfChanged(db, file)).toBe('kept');
    expect(existsSync(file)).toBe(true);
  });
  it('is removed once the password has been changed, and only then', async () => {
    await changePassword();
    expect(removeBootstrapCredentialsIfChanged(db, file)).toBe('removed');
    expect(existsSync(file)).toBe(false);
    expect(removeBootstrapCredentialsIfChanged(db, file)).toBe('none');
  });
  it('the watcher removes it by itself after the change (also on the next start)', async () => {
    let removed = 0;
    const stop = watchBootstrapCredentials(db, file, { intervalMs: 20, onRemoved: () => { removed += 1; } });
    expect(existsSync(file)).toBe(true);
    await changePassword();
    await new Promise((r) => setTimeout(r, 120));
    expect(existsSync(file)).toBe(false);
    expect(removed).toBe(1);
    stop();
    // a leftover file next to an already changed password is cleaned at start
    writeFileSync(file, 'x');
    watchBootstrapCredentials(db, file, { intervalMs: 20 })();
    expect(existsSync(file)).toBe(false);
  });
  it('a missing user or a missing file never throws', () => {
    expect(removeBootstrapCredentialsIfChanged(db, path.join(dir, 'nope.txt'))).toBe('none');
    expect(removeBootstrapCredentialsIfChanged(db, file, { username: 'ghost' })).toBe('kept');
  });
});

describe('printing the temporary password to the console', () => {
  it('only into an interactive terminal unless told otherwise', () => {
    expect(bootstrapPrintAllowed({}, { isTTY: true })).toBe(true);
    expect(bootstrapPrintAllowed({}, { isTTY: false })).toBe(false);
    expect(bootstrapPrintAllowed({}, {})).toBe(false);
    expect(bootstrapPrintAllowed({ DAS_BOOTSTRAP_PRINT: 'true' }, { isTTY: false })).toBe(true);
    expect(bootstrapPrintAllowed({ DAS_BOOTSTRAP_PRINT: 'false' }, { isTTY: true })).toBe(false);
  });
});
