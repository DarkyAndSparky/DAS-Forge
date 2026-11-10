import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import { createSqliteAdapter } from '../src/database/index.js';
import { runMigrations } from '../src/cli/migrator.js';
import {
  checkHealth,
  healthHandler,
  runDoctor,
  formatDoctorText,
  formatDoctorJson,
  runtimeChecks,
  databaseChecks,
  storageChecks,
  securityChecks,
  applicationChecks,
} from '../src/health/index.js';

describe('checkHealth / healthHandler', () => {
  let db;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed by a test that exercises the degraded path
    }
  });

  it('reports ok when the database answers', () => {
    const result = checkHealth(db, { version: '26w40-b03' });
    expect(result).toMatchObject({ status: 'ok', database: 'ok', version: '26w40-b03' });
    expect(typeof result.uptime).toBe('number');
  });

  it('reports degraded when the database connection is dead', () => {
    db.close();
    const result = checkHealth(db);
    expect(result.status).toBe('degraded');
    expect(result.database).toBe('error');
  });

  it('healthHandler responds 200 on ok and 503 on degraded', () => {
    let status;
    let body;
    const res = {
      status(code) {
        status = code;
        return this;
      },
      json(b) {
        body = b;
      },
    };

    healthHandler(db, { version: 'v1' })({}, res);
    expect(status).toBe(200);
    expect(body.status).toBe('ok');

    db.close();
    healthHandler(db)({}, res);
    expect(status).toBe(503);
  });
});

describe('runtimeChecks', () => {
  it('passes with a low minNodeMajor and fails with an impossibly high one', () => {
    expect(runtimeChecks({ minNodeMajor: 1 }).every((c) => c.status === 'ok')).toBe(true);
    expect(runtimeChecks({ minNodeMajor: 999 })[0].status).toBe('fail');
  });
});

describe('databaseChecks', () => {
  let db;
  let migrationsDir;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    migrationsDir = mkdtempSync(path.join(os.tmpdir(), 'das-forge-health-migtest-'));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed by the "dead connection" test
    }
    rmSync(migrationsDir, { recursive: true, force: true });
  });

  it('reports ok for connection and integrity with no migrationsDir given', () => {
    const results = databaseChecks(db, {});
    expect(results.every((c) => c.status === 'ok')).toBe(true);
    expect(results.find((c) => c.name === 'Migrations')).toBeUndefined();
  });

  it('short-circuits to a single failing Connection check on a dead db', () => {
    db.close();
    const results = databaseChecks(db, {});
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'Connection', status: 'fail' });
  });

  it('reports pending migrations as fail, then ok after applying them', async () => {
    writeFileSync(
      path.join(migrationsDir, '001_init.js'),
      "export function up(db){ db.exec('CREATE TABLE x (id INTEGER PRIMARY KEY)'); }"
    );

    const before = databaseChecks(db, { migrationsDir }).find((c) => c.name === 'Migrations');
    expect(before.status).toBe('fail');
    expect(before.message).toMatch(/pending/);

    await runMigrations(db, migrationsDir);

    const after = databaseChecks(db, { migrationsDir }).find((c) => c.name === 'Migrations');
    expect(after.status).toBe('ok');
    expect(after.message).toMatch(/0 pending/);
  });
});

describe('storageChecks', () => {
  let base;

  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), 'das-forge-health-storagetest-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('reports ok for an existing writable directory', () => {
    const results = storageChecks({ data: base });
    expect(results[0]).toMatchObject({ name: 'data', status: 'ok' });
  });

  it('an optional missing directory is a warning with a fix, not a failure', () => {
    const dir = path.join(base, 'backups');
    const r = storageChecks({ 'backup:local-1': { path: dir, optional: true } })[0];
    expect(r.status).toBe('warn');
    expect(r.message).toContain('first backup');
    r.fix();
    expect(storageChecks({ x: { path: dir, optional: true } })[0].status).toBe('ok');
  });

  it('reports fail with a working fix() for a missing directory', () => {
    const missing = path.join(base, 'uploads');
    const [check] = storageChecks({ uploads: missing });
    expect(check.status).toBe('fail');
    expect(typeof check.fix).toBe('function');

    check.fix();
    expect(existsSync(missing)).toBe(true);
    expect(storageChecks({ uploads: missing })[0].status).toBe('ok');
  });
});

describe('securityChecks', () => {
  it('fails a short or placeholder session secret', () => {
    expect(
      securityChecks({ auth: { sessionSecret: 'short' }, server: {}, env: 'production' })[0].status
    ).toBe('fail');
    expect(
      securityChecks({ auth: { sessionSecret: 'changeme' }, server: {}, env: 'production' })[0].status
    ).toBe('fail');
  });

  it('passes a strong secret and flags self-signed HTTPS only in production', () => {
    const strong = 'a-genuinely-random-32-char-secret-value';

    const prod = securityChecks({
      auth: { sessionSecret: strong },
      server: { https: { mode: 'self-signed' } },
      env: 'production',
    });
    expect(prod.find((c) => c.name === 'Session secret').status).toBe('ok');
    expect(prod.find((c) => c.name === 'HTTPS mode').status).toBe('warn');

    const dev = securityChecks({ auth: { sessionSecret: strong }, server: {}, env: 'development' });
    expect(dev.find((c) => c.name === 'HTTPS mode').status).toBe('ok');
  });
});

describe('applicationChecks', () => {
  it('is a no-op without a port', async () => {
    expect(await applicationChecks({})).toEqual([]);
  });

  it('detects a busy port, then ok once freed', async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const busy = await applicationChecks({ host: '127.0.0.1', port, timeoutMs: 300 });
    expect(busy[0].status).toBe('warn');

    await new Promise((resolve) => server.close(resolve));

    const free = await applicationChecks({ host: '127.0.0.1', port, timeoutMs: 300 });
    expect(free[0].status).toBe('ok');
  });
});

describe('applicationChecks inside the running server', () => {
  it('reports a busy port as ok and a free one as the problem', async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const busy = await applicationChecks({ host: '127.0.0.1', port, timeoutMs: 300, inProcess: true });
    expect(busy[0].status).toBe('ok');
    expect(busy[0].message).toContain('in use by this application');
    await new Promise((resolve) => server.close(resolve));
    const free = await applicationChecks({ host: '127.0.0.1', port, timeoutMs: 300, inProcess: true });
    expect(free[0].status).toBe('warn');
  });
});

describe('runDoctor / formatDoctorText / formatDoctorJson', () => {
  it('aggregates categories, computes summary/exitCode, and strips fix from output', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'das-forge-health-doctortest-'));
    const missing = path.join(base, 'needs-creation');

    const categoryProviders = [
      { name: 'Runtime', run: () => runtimeChecks({ minNodeMajor: 1 }) },
      { name: 'Storage', run: () => storageChecks({ data: missing }) },
    ];

    const withoutFix = await runDoctor(categoryProviders, { fix: false });
    // Runtime contributes TWO 'ok' checks (Node.js version + Platform -
    // see health/checks/runtime.js), not one; Storage contributes the
    // single 'fail'. This test previously only ran as a syntax check
    // (no vitest install in the dev container) - the real run surfaced
    // that the original expectation undercounted Runtime's checks.
    expect(withoutFix.summary).toEqual({ ok: 2, warn: 0, fail: 1 });
    expect(withoutFix.exitCode).toBe(3);
    expect(withoutFix.categories[1].checks[0].fix).toBeUndefined();
    expect(existsSync(missing)).toBe(false);

    const withFix = await runDoctor(categoryProviders, { fix: true });
    expect(withFix.summary.fail).toBe(0);
    expect(withFix.exitCode).toBe(0);
    expect(existsSync(missing)).toBe(true);

    rmSync(base, { recursive: true, force: true });
  });

  it('formats as readable text and as parseable JSON', async () => {
    const result = await runDoctor([{ name: 'Runtime', run: () => runtimeChecks({ minNodeMajor: 1 }) }]);

    const text = formatDoctorText(result, { title: 'Workshop Doctor' });
    expect(text).toContain('Workshop Doctor');
    expect(text).toContain('All checks passed');

    const parsed = JSON.parse(formatDoctorJson(result));
    expect(parsed.summary.ok).toBeGreaterThan(0);
  });
});
