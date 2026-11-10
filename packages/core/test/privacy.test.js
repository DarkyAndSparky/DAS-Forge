import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createSqliteAdapter } from '../src/database/index.js';
import { createUser, findUserById, findUserByUsername, anonymizeUser, deleteUser } from '../src/auth/index.js';
import { log as auditLog, tail as auditTail } from '../src/audit/index.js';
import { createModuleRegistry } from '../src/modules/index.js';
import { exportUserData } from '../src/privacy/export.js';
import { eraseUserData } from '../src/privacy/erase.js';
import { createCli } from '../src/cli/cli.js';
import { registerPrivacyCommands } from '../src/cli/commands/privacy.js';

describe('auth: anonymizeUser / deleteUser', () => {
  let db;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
  });

  afterEach(() => {
    db.close();
  });

  it('anonymizeUser replaces identifying fields, disables login, and keeps the row', () => {
    const user = createUser(db, { username: 'alice', email: 'alice@example.com', passwordHash: 'h' });
    const result = anonymizeUser(db, user.id);

    expect(result.username).toBe(`deleted-user-${user.id}`);
    expect(result.email).toBeNull();
    expect(result.passwordHash).toBe('');
    expect(result.totpSecret).toBeNull();
    expect(result.disabled).toBe(true);
    expect(findUserById(db, user.id)).not.toBeNull();
  });

  it('anonymizeUser returns null for an unknown id', () => {
    expect(anonymizeUser(db, 999999)).toBeNull();
  });

  it('deleteUser removes the row and reports whether one existed', () => {
    const user = createUser(db, { username: 'bob', passwordHash: 'h' });
    expect(deleteUser(db, user.id)).toBe(true);
    expect(findUserById(db, user.id)).toBeNull();
    expect(deleteUser(db, user.id)).toBe(false);
  });
});

describe('privacy: exportUserData / eraseUserData', () => {
  let db;
  let registry;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    registry = createModuleRegistry();
  });

  afterEach(() => {
    db.close();
  });

  it('exportUserData collects the user record plus every module\'s dataSubject.export()', async () => {
    const user = createUser(db, { username: 'alice', email: 'alice@example.com', passwordHash: 'h' });
    registry.registerModule({ id: 'reporting', dataSubject: { export: async () => ({ reports: ['Q1'] }), erase: async () => {} } });

    const result = await exportUserData({ db, findUserByIdFn: findUserById, moduleRegistry: registry, userId: user.id, auditLogFn: auditLog, actor: 'hr' });

    expect(result.user).toMatchObject({ username: 'alice', email: 'alice@example.com' });
    expect(result.modules.reporting).toEqual({ reports: ['Q1'] });
    expect(auditTail(db, { limit: 1 })[0]).toMatchObject({ action: 'privacy.export', actor: 'hr' });
  });

  it('exportUserData throws for an unknown user', async () => {
    await expect(exportUserData({ db, findUserByIdFn: findUserById, moduleRegistry: registry, userId: 999999 })).rejects.toThrow();
  });

  it('exportUserData records a module\'s export() failure without hiding other modules\' data', async () => {
    const user = createUser(db, { username: 'alice', passwordHash: 'h' });
    registry.registerModule({ id: 'good', dataSubject: { export: async () => ({ ok: true }), erase: async () => {} } });
    registry.registerModule({ id: 'bad', dataSubject: { export: async () => { throw new Error('boom'); }, erase: async () => {} } });

    const result = await exportUserData({ db, findUserByIdFn: findUserById, moduleRegistry: registry, userId: user.id });
    expect(result.modules.good).toEqual({ ok: true });
    expect(result.modules.bad.error).toBe('boom');
  });

  it('eraseUserData defaults to anonymize, calls every module\'s erase(), and preserves prior audit history', async () => {
    const user = createUser(db, { username: 'alice', email: 'alice@example.com', passwordHash: 'h' });
    auditLog(db, { actor: 'alice', action: 'asset.view' });

    const eraseCalls = [];
    registry.registerModule({
      id: 'reporting',
      dataSubject: { export: async () => ({}), erase: async (userId, opts) => eraseCalls.push({ userId, ...opts }) },
    });

    const result = await eraseUserData({
      db,
      findUserByIdFn: findUserById,
      anonymizeUserFn: anonymizeUser,
      deleteUserFn: deleteUser,
      moduleRegistry: registry,
      userId: user.id,
      auditLogFn: auditLog,
      actor: 'hr',
    });

    expect(result.mode).toBe('anonymize');
    expect(result.accountErased).toBe(true);
    expect(eraseCalls).toEqual([{ userId: user.id, mode: 'anonymize' }]);
    expect(findUserById(db, user.id).username).toBe(`deleted-user-${user.id}`);

    // original audit entry logged under the ORIGINAL username is untouched
    const history = auditTail(db, { limit: 10 });
    expect(history.some((e) => e.actor === 'alice' && e.action === 'asset.view')).toBe(true);
  });

  it('eraseUserData with mode "delete" actually removes the row', async () => {
    const user = createUser(db, { username: 'bob', passwordHash: 'h' });
    registry.registerModule({ id: 'reporting', dataSubject: { export: async () => ({}), erase: async () => {} } });

    const result = await eraseUserData({
      db,
      findUserByIdFn: findUserById,
      anonymizeUserFn: anonymizeUser,
      deleteUserFn: deleteUser,
      moduleRegistry: registry,
      userId: user.id,
      mode: 'delete',
    });

    expect(result.mode).toBe('delete');
    expect(result.accountErased).toBe(true);
    expect(findUserById(db, user.id)).toBeNull();
  });

  it('eraseUserData rejects an invalid mode', async () => {
    const user = createUser(db, { username: 'alice', passwordHash: 'h' });
    await expect(
      eraseUserData({ db, findUserByIdFn: findUserById, anonymizeUserFn: anonymizeUser, deleteUserFn: deleteUser, moduleRegistry: registry, userId: user.id, mode: 'wipe' })
    ).rejects.toThrow(TypeError);
  });

  it('eraseUserData records a failing module erase() without aborting the others', async () => {
    const user = createUser(db, { username: 'alice', passwordHash: 'h' });
    registry.registerModule({ id: 'good', dataSubject: { export: async () => ({}), erase: async () => {} } });
    registry.registerModule({ id: 'bad', dataSubject: { export: async () => ({}), erase: async () => { throw new Error('nope'); } } });

    const result = await eraseUserData({ db, findUserByIdFn: findUserById, anonymizeUserFn: anonymizeUser, deleteUserFn: deleteUser, moduleRegistry: registry, userId: user.id });

    expect(result.moduleResults.good).toBe('ok');
    expect(result.moduleResults.bad).toMatch(/error: nope/);
    expect(result.accountErased).toBe(true); // the account itself is still erased
  });
});

describe('registerPrivacyCommands', () => {
  let db;
  let registry;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    registry = createModuleRegistry();
  });

  afterEach(() => {
    db.close();
  });

  function buildCli() {
    const cli = createCli();
    registerPrivacyCommands(cli, {
      findUserByUsernameFn: (u) => findUserByUsername(db, u),
      exportUserDataFn: (opts) => exportUserData({ db, findUserByIdFn: findUserById, moduleRegistry: registry, auditLogFn: auditLog, ...opts }),
      eraseUserDataFn: (opts) =>
        eraseUserData({ db, findUserByIdFn: findUserById, anonymizeUserFn: anonymizeUser, deleteUserFn: deleteUser, moduleRegistry: registry, auditLogFn: auditLog, ...opts }),
    });
    return cli;
  }

  async function capture(fn) {
    const logs = [];
    const errs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => logs.push(a.join(' '));
    console.error = (...a) => errs.push(a.join(' '));
    let code;
    try {
      code = await fn();
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    return { code, logs, errs };
  }

  it('export requires --user, fails cleanly for an unknown user, writes to --out', async () => {
    createUser(db, { username: 'alice', passwordHash: 'h' });
    const cli = buildCli();

    let r = await capture(() => cli.run(['privacy', 'export']));
    expect(r.code).toBe(2);

    r = await capture(() => cli.run(['privacy', 'export', '--user', 'ghost']));
    expect(r.code).toBe(1);
    expect(r.errs.join('\n')).toMatch(/No such user/);

    r = await capture(() => cli.run(['privacy', 'export', '--user', 'alice']));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.logs[0]).user.username).toBe('alice');
  });

  it('erase requires --yes, defaults to anonymize, and requires --mode delete explicitly for a hard delete', async () => {
    createUser(db, { username: 'alice', passwordHash: 'h' });
    const cli = buildCli();

    let r = await capture(() => cli.run(['privacy', 'erase', '--user', 'alice']));
    expect(r.code).toBe(1);
    expect(r.errs.join('\n')).toMatch(/--yes/);

    r = await capture(() => cli.run(['privacy', 'erase', '--user', 'alice', '--yes']));
    expect(r.code).toBe(0);
    expect(findUserByUsername(db, 'alice')).toBeNull();

    createUser(db, { username: 'bob', passwordHash: 'h' });
    r = await capture(() => cli.run(['privacy', 'erase', '--user', 'bob', '--mode', 'delete', '--yes']));
    expect(r.code).toBe(0);
    expect(findUserByUsername(db, 'bob')).toBeNull();

    r = await capture(() => cli.run(['privacy', 'erase', '--user', 'carol', '--mode', 'bogus', '--yes']));
    expect(r.code).toBe(2);
  });
});
