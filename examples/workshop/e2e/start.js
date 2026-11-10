// Starts the workshop for the browser tests on an EMPTY throw-away database with a known admin.
// Playwright's webServer runs this file; it is not part of the app.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'workshop-e2e-'));

process.env.DAS_DB_FILE = path.join(dataDir, 'workshop.db');
process.env.DAS_HOST = '127.0.0.1';
process.env.DAS_PORT = process.env.E2E_PORT ?? '4399';
process.env.DAS_SESSION_SECRET = 'e2e-only-session-secret-0123456789abcdef';
process.env.DAS_LOG_LEVEL = 'silent';
process.env.DAS_BOOTSTRAP_PRINT = 'false';
process.env.DAS_E2E = '1'; // lifts the general request limit for the browser tests (see src/context.js)

export const E2E_ADMIN = { username: 'e2eadmin', password: 'e2e-admin-password-1' };

const { buildContext } = await import('../src/context.js');
const { cli, auth } = await import('@das-forge/core');

const ctx = await buildContext(); // first-run bootstrap creates the initial admin
await cli.runMigrations(ctx.db, ctx.migrationsDir);
const hash = await auth.hashPassword(E2E_ADMIN.password, ctx.appConfig.auth.argon2);
ctx.db.run(`UPDATE users SET username = ?, password_hash = ?, must_change_password = 0, role = 'admin'`, [E2E_ADMIN.username, hash]);
ctx.db.close();

const child = spawn(process.execPath, [path.resolve(here, '../src/server.js')], { stdio: 'inherit', env: process.env });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
