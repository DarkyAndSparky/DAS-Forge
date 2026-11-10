import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCli } from '../src/cli/cli.js';
import { createSqliteAdapter } from '../src/database/index.js';
import { runMigrations } from '../src/cli/migrator.js';
import { createBackupJob, listBackups, verifyBackupFile, restoreBackup } from '../src/scheduler/index.js';
import { log as auditLog, tail as auditTail, query as auditQuery } from '../src/audit/index.js';
import { createUser, findUserByUsername, updatePasswordHash, countUsers } from '../src/auth/index.js';
import { listAuthenticators, startTotpEnrollment, verifyTotpEnrollment, removeAuthenticator } from '../src/auth/authenticators.js';
import { generateTotp } from '../src/auth/totp.js';
import { generateRecoveryCodes, verifyAndConsumeRecoveryCode } from '../src/auth/recovery-codes.js';

import { registerBackupCommands } from '../src/cli/commands/backup.js';
import { registerDbCommands } from '../src/cli/commands/db.js';
import { registerAuditCommands } from '../src/cli/commands/audit.js';
import { registerVersionCommand } from '../src/cli/commands/version.js';
import { registerUserCommands } from '../src/cli/commands/user-admin.js';

/** Captures console.log/console.error output for one cli.run() call. */
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

describe('registerBackupCommands: list / verify / restore', () => {
  let root;
  let dbFilePath;
  let backupDir;
  let migrationsDir;
  let db;
  let destinations;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'das-forge-cli-backup-'));
    dbFilePath = path.join(root, 'app.db');
    backupDir = path.join(root, 'backups');
    migrationsDir = path.join(root, 'migrations');
    mkdirSync(migrationsDir, { recursive: true });

    db = createSqliteAdapter({ file: dbFilePath });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.run('INSERT INTO t (v) VALUES (?)', ['original']);

    destinations = [{ id: 'local-1', type: 'local', path: backupDir }];
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // restore tests close/reopen db themselves
    }
    rmSync(root, { recursive: true, force: true });
  });

  function buildCli() {
    const cli = createCli();
    const runBackupFn = createBackupJob({ db, dbFilePath, destinations, retentionDays: 30 });
    registerBackupCommands(cli, {
      runBackupFn,
      listBackupsFn: () => listBackups(destinations),
      verifyBackupFn: (file) => verifyBackupFile(createSqliteAdapter, file),
      restoreBackupFn: async (file) => {
        db.close();
        const result = await restoreBackup({ dbFilePath, backupFilePath: file, migrationsDir, createAdapterFn: createSqliteAdapter });
        if (result.db) db = result.db;
        return result;
      },
    });
    return cli;
  }

  it('list reports no backups before any run, then finds one after', async () => {
    const cli = buildCli();
    let r = await capture(() => cli.run(['backup', 'list']));
    expect(r.code).toBe(0);
    expect(r.logs.join('\n')).toMatch(/No backups found/);

    await capture(() => cli.run(['backup', 'run']));

    r = await capture(() => cli.run(['backup', 'list', '--json']));
    const backups = JSON.parse(r.logs[0]);
    expect(backups).toHaveLength(1);
  });

  it('verify requires a file argument and reports integrity of a real backup', async () => {
    const cli = buildCli();
    let r = await capture(() => cli.run(['backup', 'verify']));
    expect(r.code).toBe(2);

    await capture(() => cli.run(['backup', 'run']));
    const listed = listBackups(destinations);

    r = await capture(() => cli.run(['backup', 'verify', listed[0].path, '--json']));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.logs[0]).ok).toBe(true);
  });

  it('restore refuses without --yes and succeeds with --yes, replacing live data', async () => {
    const cli = buildCli();
    await capture(() => cli.run(['backup', 'run']));
    const listed = listBackups(destinations);

    db.run('INSERT INTO t (v) VALUES (?)', ['added-after-backup']);
    expect(db.all('SELECT * FROM t')).toHaveLength(2);

    let r = await capture(() => cli.run(['backup', 'restore', listed[0].path]));
    expect(r.code).toBe(1);
    expect(r.errs.join('\n')).toMatch(/--yes/);

    r = await capture(() => cli.run(['backup', 'restore', listed[0].path, '--yes']));
    expect(r.code).toBe(0);
    expect(r.logs.some((l) => l.includes('Health check'))).toBe(true);

    expect(db.all('SELECT * FROM t')).toHaveLength(1);
  });
});

describe('registerDbCommands', () => {
  let db;
  let migrationsDir;
  let dbFilePath;
  let root;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'das-forge-cli-db-'));
    dbFilePath = path.join(root, 'app.db');
    migrationsDir = path.join(root, 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    db = createSqliteAdapter({ file: dbFilePath });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('status reports pending migrations, ok after applying them', async () => {
    writeFileSync(path.join(migrationsDir, '001_init.js'), "export function up(db){ db.exec('CREATE TABLE x (id INTEGER PRIMARY KEY)'); }");

    const cli = createCli();
    registerDbCommands(cli, { db, migrationsDir, dbFilePath });

    let r = await capture(() => cli.run(['db', 'status', '--json']));
    expect(r.code).toBe(1);
    expect(JSON.parse(r.logs[0]).migrations.pending).toBe(1);

    await runMigrations(db, migrationsDir);

    r = await capture(() => cli.run(['db', 'status', '--json']));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.logs[0]).migrations.pending).toBe(0);
  });

  it('integrity reports ok for a healthy database and runs VACUUM with --repair', async () => {
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    const cli = createCli();
    registerDbCommands(cli, { db, migrationsDir, dbFilePath });

    const r = await capture(() => cli.run(['db', 'integrity', '--repair']));
    expect(r.code).toBe(0);
    expect(r.logs.join('\n')).toMatch(/integrity OK/);
    expect(r.logs.join('\n')).toMatch(/VACUUM complete/);
  });
});

describe('registerAuditCommands', () => {
  let db;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
  });

  afterEach(() => {
    db.close();
  });

  it('tail shows recent entries, including failures', async () => {
    auditLog(db, { actor: 'alice', action: 'widget.create' });
    auditLog(db, { actor: 'bob', action: 'widget.delete', result: 'failure' });

    const cli = createCli();
    registerAuditCommands(cli, { db, tailFn: auditTail, queryFn: auditQuery });

    const r = await capture(() => cli.run(['audit', 'tail']));
    expect(r.code).toBe(0);
    const out = r.logs.join('\n');
    expect(out).toMatch(/widget.create/);
    expect(out).toMatch(/FAIL/);
  });

  it('export requires a file argument and writes json/csv', async () => {
    auditLog(db, { actor: 'alice', action: 'widget.create', meta: { note: 'hi' } });

    const root = mkdtempSync(path.join(os.tmpdir(), 'das-forge-cli-audit-'));
    const cli = createCli();
    registerAuditCommands(cli, { db, tailFn: auditTail, queryFn: auditQuery });

    let r = await capture(() => cli.run(['audit', 'export']));
    expect(r.code).toBe(2);

    const jsonFile = path.join(root, 'out.json');
    r = await capture(() => cli.run(['audit', 'export', jsonFile]));
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(jsonFile, 'utf8'))).toHaveLength(1);

    const csvFile = path.join(root, 'out.csv');
    r = await capture(() => cli.run(['audit', 'export', csvFile, '--format', 'csv']));
    expect(r.code).toBe(0);
    expect(readFileSync(csvFile, 'utf8').split('\n')).toHaveLength(2); // header + 1 row

    // a name chosen by a user must not run as a formula when the export is opened in a spreadsheet
    auditLog(db, { actor: '=HYPERLINK("http://x","y")', action: 'widget.create' });
    r = await capture(() => cli.run(['audit', 'export', path.join(root, 'evil.csv'), '--format', 'csv']));
    expect(r.code).toBe(0);
    const evil = readFileSync(path.join(root, 'evil.csv'), 'utf8');
    expect(evil).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(evil).not.toMatch(/(^|,)=HYPERLINK/m);

    rmSync(root, { recursive: true, force: true });
  });
});

describe('registerVersionCommand', () => {
  it('prints the given version string, plain or as json', async () => {
    const cli = createCli();
    registerVersionCommand(cli, { version: '1.2.3' });

    let r = await capture(() => cli.run(['version']));
    expect(r.code).toBe(0);
    expect(r.logs[0]).toBe('1.2.3');

    r = await capture(() => cli.run(['version', '--json']));
    expect(JSON.parse(r.logs[0])).toEqual({ version: '1.2.3' });
  });
});

describe('registerUserCommands: reset-password', () => {
  let db;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
  });

  afterEach(() => {
    db.close();
  });

  const hashPassword = async (plain) => `hashed:${plain}`;

  it('resets an existing user, fails cleanly for an unknown one, and requires a username', async () => {
    createUser(db, { username: 'alice', passwordHash: 'old', role: 'operator', mustChangePassword: false });

    const cli = createCli();
    registerUserCommands(cli, { db, hashPassword, createUser, findUserByUsername, updatePasswordHash, countUsers });

    let r = await capture(() => cli.run(['user', 'reset-password', 'alice']));
    expect(r.code).toBe(0);
    expect(r.logs.join('\n')).toMatch(/Temporary password/);
    expect(findUserByUsername(db, 'alice').passwordHash).not.toBe('old');

    r = await capture(() => cli.run(['user', 'reset-password', 'ghost']));
    expect(r.code).toBe(1);
    expect(r.errs.join('\n')).toMatch(/No such user/);

    r = await capture(() => cli.run(['user', 'reset-password']));
    expect(r.code).toBe(2);
  });
});

describe('registerUserCommands: authenticators / authenticators-remove / recovery-codes', () => {
  let db;
  let alice;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    alice = createUser(db, { username: 'alice', passwordHash: 'h' });
  });

  afterEach(() => {
    db.close();
  });

  const hashPassword = async (plain) => `hashed:${plain}`;

  function buildCli() {
    const cli = createCli();
    registerUserCommands(cli, {
      db,
      hashPassword,
      createUser,
      findUserByUsername,
      updatePasswordHash,
      countUsers,
      listAuthenticators,
      removeAuthenticator,
      generateRecoveryCodes,
    });
    return cli;
  }

  it('authenticators lists a real enrolled authenticator, fails cleanly otherwise', async () => {
    const enroll = startTotpEnrollment(db, alice.id, { accountName: 'alice' });
    verifyTotpEnrollment(db, enroll.authenticatorId, generateTotp(enroll.secret));

    const cli = buildCli();

    let r = await capture(() => cli.run(['user', 'authenticators']));
    expect(r.code).toBe(2);

    r = await capture(() => cli.run(['user', 'authenticators', 'ghost']));
    expect(r.code).toBe(1);

    r = await capture(() => cli.run(['user', 'authenticators', 'alice', '--json']));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.logs[0])[0]).toMatchObject({ status: 'active' });
  });

  it('authenticators-remove is protected by default and overridable with --force', async () => {
    const enroll = startTotpEnrollment(db, alice.id, { accountName: 'alice' });
    verifyTotpEnrollment(db, enroll.authenticatorId, generateTotp(enroll.secret));

    const cli = buildCli();

    let r = await capture(() => cli.run(['user', 'authenticators-remove', 'alice', String(enroll.authenticatorId)]));
    expect(r.code).toBe(1);
    expect(r.errs.join('\n')).toMatch(/last one/);
    expect(listAuthenticators(db, alice.id)).toHaveLength(1);

    r = await capture(() => cli.run(['user', 'authenticators-remove', 'alice', String(enroll.authenticatorId), '--force']));
    expect(r.code).toBe(0);
    expect(listAuthenticators(db, alice.id)).toHaveLength(0);
  });

  it('recovery-codes generates a real, usable set', async () => {
    const cli = buildCli();
    const r = await capture(() => cli.run(['user', 'recovery-codes', 'alice', '--count', '3']));
    expect(r.code).toBe(0);

    const printed = r.logs.join('\n').split('\n').filter((l) => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(l));
    expect(printed).toHaveLength(3);
    expect(await verifyAndConsumeRecoveryCode(db, alice.id, printed[0])).toBe(true);
  });
});
