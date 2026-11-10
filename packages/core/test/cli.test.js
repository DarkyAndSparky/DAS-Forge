import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseArgs } from '../src/cli/arg-parser.js';
import { createCli } from '../src/cli/cli.js';
import { runMigrations, migrationStatus } from '../src/cli/migrator.js';
import { registerConfigCheckCommand } from '../src/cli/commands/config-check.js';
import { registerUserCommands } from '../src/cli/commands/user-admin.js';
import { registerMigrateCommands } from '../src/cli/commands/migrate.js';
import { registerBackupCommands } from '../src/cli/commands/backup.js';
import { createSqliteAdapter } from '../src/database/index.js';
import { ConfigValidationError } from '../src/config/errors.js';

describe('parseArgs', () => {
  it('splits positionals from flags', () => {
    const { positionals, flags } = parseArgs(['config', 'check', '--cwd=/tmp']);
    expect(positionals).toEqual(['config', 'check']);
    expect(flags).toEqual({ cwd: '/tmp' });
  });

  it('supports "--flag value" (space-separated) form', () => {
    const { flags } = parseArgs(['user', 'create-admin', '--username', 'bob']);
    expect(flags.username).toBe('bob');
  });

  it('treats a flag with no following value (or followed by another flag) as boolean true', () => {
    const { flags } = parseArgs(['user', 'create-admin', '--force']);
    expect(flags.force).toBe(true);
  });

  it('boolean flag followed by another flag stays boolean', () => {
    const { flags } = parseArgs(['--force', '--username=bob']);
    expect(flags.force).toBe(true);
    expect(flags.username).toBe('bob');
  });
});

describe('createCli', () => {
  let logs, errors;
  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));
  });
  afterEach(() => vi.restoreAllMocks());

  it('dispatches to the matching registered command', async () => {
    const cli = createCli();
    const handler = vi.fn(() => 0);
    cli.command('config check', { description: 'x', handler });
    const code = await cli.run(['config', 'check']);
    expect(handler).toHaveBeenCalled();
    expect(code).toBe(0);
  });

  it('matches the longest registered prefix and passes remaining positionals through', async () => {
    const cli = createCli();
    let received;
    cli.command('migrate', { description: 'x', handler: (ctx) => { received = ctx.positionals; return 0; } });
    cli.command('migrate status', { description: 'x', handler: () => 1 });
    const code = await cli.run(['migrate', 'status']);
    expect(code).toBe(1); // matched "migrate status", not "migrate" + leftover "status"
  });

  it('prints usage and returns 1 for no command', async () => {
    const cli = createCli();
    cli.command('x', { description: 'd', handler: () => 0 });
    const code = await cli.run([]);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('Usage:');
  });

  it('returns 1 and prints an error for an unknown command', async () => {
    const cli = createCli();
    cli.command('known', { description: 'd', handler: () => 0 });
    const code = await cli.run(['nope']);
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('Unknown command');
  });

  it('catches a throwing handler and returns exit code 1', async () => {
    const cli = createCli();
    cli.command('boom', { description: 'd', handler: () => { throw new Error('kaboom'); } });
    const code = await cli.run(['boom']);
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('kaboom');
  });

  it('rejects registering the same command path twice', () => {
    const cli = createCli();
    cli.command('dup', { description: 'd', handler: () => 0 });
    expect(() => cli.command('dup', { description: 'd', handler: () => 0 })).toThrow(/already registered/);
  });

  // "man для CLI" - docs/roadmap.md's long-open backlog item, closed as
  // a mechanism in 0.1.18 (filling in usage/flags/examples per existing
  // command is left as follow-up, see the roadmap note).
  describe('per-command help ("man"-style, 0.1.18)', () => {
    it('"help <command>" prints the command detail, not the global list, and does not run the handler', async () => {
      const cli = createCli();
      const handler = vi.fn(() => 0);
      cli.command('user create-admin', {
        description: 'Create admin user',
        usage: '[--force]',
        flags: [{ name: '--force', description: 'Reset even if DB is non-empty' }],
        examples: ['user create-admin --force'],
        handler,
      });
      const code = await cli.run(['help', 'user', 'create-admin']);
      expect(code).toBe(0);
      expect(handler).not.toHaveBeenCalled();
      const out = logs.join('\n');
      expect(out).toContain('Usage: app user create-admin [--force]');
      expect(out).toContain('--force');
      expect(out).toContain('Reset even if DB is non-empty');
      expect(out).toContain('app user create-admin --force');
    });

    it('"<command> --help" reaches the same per-command help (the other entry point)', async () => {
      const cli = createCli();
      const handler = vi.fn(() => 0);
      cli.command('config check', { description: 'Validate config', handler });
      const code = await cli.run(['config', 'check', '--help']);
      expect(code).toBe(0);
      expect(handler).not.toHaveBeenCalled();
      expect(logs.join('\n')).toContain('Validate config');
    });

    it('a command with no usage/flags/examples filled in still gets a help page, honestly marked as thin', async () => {
      const cli = createCli();
      cli.command('migrate', { description: 'Apply migrations', handler: () => 0 });
      const code = await cli.run(['migrate', '--help']);
      expect(code).toBe(0);
      expect(logs.join('\n')).toContain('No detailed flag/example reference yet');
    });

    it('matches the longest prefix for help too - "migrate --help" is NOT "migrate status"\'s help', async () => {
      const cli = createCli();
      cli.command('migrate', { description: 'Apply migrations', handler: () => 0 });
      cli.command('migrate status', { description: 'Show migration status', handler: () => 0 });
      const code = await cli.run(['migrate', '--help']);
      expect(code).toBe(0);
      const out = logs.join('\n');
      expect(out).toContain('Apply migrations');
      expect(out).not.toContain('Show migration status');
    });

    it('"help" alone (no command) prints the same global usage as no args at all', async () => {
      const cli = createCli();
      cli.command('x', { description: 'd', handler: () => 0 });
      const code = await cli.run(['help']);
      expect(code).toBe(0); // explicit help request - unlike bare `run([])`, this is not a usage error
      expect(logs.join('\n')).toContain('Usage:');
    });

    it('"help <unknown command>" reports the same way an unknown top-level command does', async () => {
      const cli = createCli();
      cli.command('known', { description: 'd', handler: () => 0 });
      const code = await cli.run(['help', 'nope']);
      expect(code).toBe(1);
      expect(errors.join('\n')).toContain('Unknown command');
    });

    it('bare "--help" with no command exits 0 (a real help request), unlike a genuinely bare invocation', async () => {
      const cli = createCli();
      cli.command('x', { description: 'd', handler: () => 0 });
      expect(await cli.run(['--help'])).toBe(0);
      expect(await cli.run([])).toBe(1); // unchanged pre-existing behavior
    });
  });
});

describe('migrator', () => {
  let db, migrationsDir;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    migrationsDir = mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  });

  afterEach(() => {
    db.close();
    rmSync(migrationsDir, { recursive: true, force: true });
  });

  function writeMigration(filename, body) {
    writeFileSync(path.join(migrationsDir, filename), body);
  }

  it('applies pending migrations in order and records them', async () => {
    writeMigration('001_create_widgets.js', `
      export function up(db) {
        db.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)');
      }
    `);
    writeMigration('002_seed_widgets.js', `
      export function up(db) {
        db.run('INSERT INTO widgets (name) VALUES (?)', ['first']);
      }
    `);

    const { applied } = await runMigrations(db, migrationsDir);
    expect(applied.map((m) => m.version)).toEqual([1, 2]);

    const rows = db.all('SELECT * FROM widgets');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('first');
  });

  it('is idempotent - running twice does not re-apply', async () => {
    writeMigration('001_create_widgets.js', `
      export function up(db) {
        db.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY)');
      }
    `);
    await runMigrations(db, migrationsDir);
    const second = await runMigrations(db, migrationsDir);
    expect(second.applied).toHaveLength(0);
  });

  it('only applies newly-added migrations on a later run', async () => {
    writeMigration('001_a.js', `export function up(db) { db.exec('CREATE TABLE a (id INTEGER)'); }`);
    await runMigrations(db, migrationsDir);
    writeMigration('002_b.js', `export function up(db) { db.exec('CREATE TABLE b (id INTEGER)'); }`);
    const result = await runMigrations(db, migrationsDir);
    expect(result.applied.map((m) => m.version)).toEqual([2]);
  });

  it('migrationStatus reports applied vs pending', async () => {
    writeMigration('001_a.js', `export function up(db) { db.exec('CREATE TABLE a (id INTEGER)'); }`);
    await runMigrations(db, migrationsDir); // applies 001 only
    writeMigration('002_b.js', `export function up(db) { db.exec('CREATE TABLE b (id INTEGER)'); }`); // never applied

    const status = migrationStatus(db, migrationsDir);
    expect(status).toEqual([
      { version: 1, name: '001_a.js', applied: true, modified: false },
      { version: 2, name: '002_b.js', applied: false, modified: false },
    ]);
  });

  it('rolls back a failing migration (transaction) and does not record it as applied', async () => {
    writeMigration('001_bad.js', `
      export function up(db) {
        db.exec('CREATE TABLE ok_table (id INTEGER)');
        db.exec('THIS IS NOT VALID SQL');
      }
    `);
    await expect(runMigrations(db, migrationsDir)).rejects.toThrow();
    const status = migrationStatus(db, migrationsDir);
    expect(status[0].applied).toBe(false);
    // the table creation before the bad statement should have been rolled back too
    expect(() => db.get("SELECT * FROM ok_table")).toThrow();
  });

  it('throws a clear error when a migration file has no up() export', async () => {
    writeMigration('001_broken.js', `export const notUp = 1;`);
    await expect(runMigrations(db, migrationsDir)).rejects.toThrow(/does not export/);
  });
});

describe('registerConfigCheckCommand', () => {
  let logs, errors;
  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports success for a valid config', async () => {
    const cli = createCli();
    registerConfigCheckCommand(cli, {
      loadConfigFn: async () => ({ appName: 'it-assets', env: 'production' }),
    });
    const code = await cli.run(['config', 'check']);
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('Configuration valid');
  });

  it('reports validation errors with field details', async () => {
    const cli = createCli();
    registerConfigCheckCommand(cli, {
      loadConfigFn: async () => {
        throw new ConfigValidationError(
          { issues: [{ path: ['auth', 'sessionSecret'], message: 'too short', code: 'too_small' }] },
          { sourcePath: 'app.config.js' }
        );
      },
    });
    const code = await cli.run(['config', 'check']);
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('sessionSecret');
  });
});

describe('registerUserCommands', () => {
  let db;
  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, must_change_password INTEGER DEFAULT 0, password_hash TEXT, role TEXT)`);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function wireUserCommands(cli) {
    registerUserCommands(cli, {
      db,
      hashPassword: async (plain) => `hashed:${plain}`,
      createUser: (db, { username, passwordHash, role, mustChangePassword }) => {
        db.run('INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, ?)', [
          username, passwordHash, role, mustChangePassword ? 1 : 0,
        ]);
      },
      findUserByUsername: (db, username) => db.get('SELECT * FROM users WHERE username = ?', [username]),
      updatePasswordHash: (db, id, hash, { clearMustChange }) =>
        db.run('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?', [hash, clearMustChange ? 0 : 1, id]),
      countUsers: (db) => db.get('SELECT COUNT(*) AS c FROM users').c,
    });
  }

  it('creates an admin when no users exist, without needing --force', async () => {
    const cli = createCli();
    wireUserCommands(cli);
    const code = await cli.run(['user', 'create-admin']);
    expect(code).toBe(0);
    const user = db.get('SELECT * FROM users WHERE username = ?', ['admin']);
    expect(user.role).toBe('admin');
  });

  it('refuses when users exist and --force is not given', async () => {
    db.run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', ['existing', 'x', 'operator']);
    const cli = createCli();
    wireUserCommands(cli);
    const code = await cli.run(['user', 'create-admin']);
    expect(code).toBe(1);
  });

  it('resets an existing user password with --force', async () => {
    db.run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', ['admin', 'oldhash', 'admin']);
    const cli = createCli();
    wireUserCommands(cli);
    const code = await cli.run(['user', 'create-admin', '--force']);
    expect(code).toBe(0);
    const user = db.get('SELECT * FROM users WHERE username = ?', ['admin']);
    expect(user.password_hash).not.toBe('oldhash');
    expect(user.must_change_password).toBe(1);
  });
});

describe('registerMigrateCommands', () => {
  let db, migrationsDir;
  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    migrationsDir = mkdtempSync(path.join(os.tmpdir(), 'migrations-cmd-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    db.close();
    rmSync(migrationsDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('applies migrations via the "migrate" command', async () => {
    writeFileSync(
      path.join(migrationsDir, '001_x.js'),
      `export function up(db) { db.exec('CREATE TABLE x (id INTEGER)'); }`
    );
    const cli = createCli();
    registerMigrateCommands(cli, { db, migrationsDir });
    const code = await cli.run(['migrate']);
    expect(code).toBe(0);
    expect(() => db.get('SELECT * FROM x')).not.toThrow();
  });

  it('"migrate status" reports without applying', async () => {
    writeFileSync(
      path.join(migrationsDir, '001_x.js'),
      `export function up(db) { db.exec('CREATE TABLE x (id INTEGER)'); }`
    );
    const cli = createCli();
    registerMigrateCommands(cli, { db, migrationsDir });
    const code = await cli.run(['migrate', 'status']);
    expect(code).toBe(0);
    expect(() => db.get('SELECT * FROM x')).toThrow(); // not applied
  });
});

describe('registerBackupCommands', () => {
  it('runs the provided backup function and reports results', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const runBackupFn = vi.fn(async () => [{ destinationId: 'local-1', backupPath: '/tmp/x.db', prunedCount: 2 }]);
    const cli = createCli();
    registerBackupCommands(cli, { runBackupFn });
    const code = await cli.run(['backup', 'run']);
    expect(code).toBe(0);
    expect(runBackupFn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
