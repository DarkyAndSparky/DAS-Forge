import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import nodeHttp from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { database, auth, config, branding, modules } from '@das-forge/core';
import { createApp } from '../src/server.js';
import { up as createNotesTable } from '../migrations/001_init.js';

/**
 * The application over real HTTP: the real middleware stack (Express, cookies, CSRF, sessions, rate limits) on an
 * ephemeral port, real argon2. It is the test to copy when you add routes: sign in, call the route, check what a
 * user WITHOUT the permission gets, check what an anonymous visitor gets.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function rawRequest(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (payload !== undefined) { h['content-length'] = Buffer.byteLength(payload); h['content-type'] = 'application/json'; }
    const req = nodeHttp.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const cookieOf = (res) => {
  const raw = [].concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('das_session='));
  return raw ? raw.split(';')[0] : undefined;
};

describe('the application over real HTTP', () => {
  let db, server, port, origin;

  beforeAll(async () => {
    const appConfig = config.validateConfig({
      appName: 'test',
      env: 'test',
      server: { host: '127.0.0.1', port: 3000, trustProxy: true, https: { mode: 'reverse-proxy' }, bodyLimit: '10kb' },
      security: { rateLimit: { windowMs: 60_000, max: 10_000 }, loginRateLimit: { windowMs: 60_000, max: 10_000 } },
      auth: { sessionSecret: 'test-session-secret-0123456789abcdef' },
    });
    db = database.createSqliteAdapter({ file: ':memory:' });
    createNotesTable(db);
    const authProvider = auth.createAuthProvider({ db, argon2Options: appConfig.auth.argon2 });
    for (const [username, password, role, mustChangePassword] of [
      ['root', 'admin-password-1', 'admin', false],
      ['ann', 'user-password-1', 'user', false],
      ['temp', 'temporary-password-1', 'user', true],
    ]) {
      auth.createUser(db, { username, passwordHash: await authProvider.hashPassword(password), role, mustChangePassword });
    }
    const { app } = createApp({
      appConfig,
      db,
      vendorIdentity: branding.defineVendorIdentity({ name: 'test', assetsDir: path.resolve(__dirname, '../assets/brand') }),
      authProvider,
      runBackupJob: async () => [],
      moduleRegistry: modules.createModuleRegistry(),
      uploadsDir: mkdtempSync(path.join(os.tmpdir(), 'app-test-')),
      migrationsDir: null,
    });
    server = nodeHttp.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server?.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  const login = (username, password) => rawRequest(port, { method: 'POST', url: '/login', headers: { origin }, body: { username, password } });
  const as = async (username, password) => {
    const res = await login(username, password);
    expect(res.status, `${username} signs in`).toBe(200);
    const cookie = cookieOf(res);
    return (method, url, body) => rawRequest(port, { method, url, headers: { origin, cookie }, body });
  };

  it('answers /health without a session and sends the security headers', async () => {
    const res = await rawRequest(port, { url: '/health' });
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain("object-src 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('the sign-in page carries the same nonce in the header and on its script', async () => {
    const res = await rawRequest(port, { url: '/login' });
    const nonce = /'nonce-([^']+)'/.exec(res.headers['content-security-policy'])?.[1];
    expect(nonce).toBeTruthy();
    expect(res.text).toContain(`<script nonce="${nonce}">`);
  });

  it('a wrong password and an unknown name get the SAME answer', async () => {
    const wrong = await login('root', 'not-the-password');
    const unknown = await login('nobody', 'whatever-password');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json).toEqual(unknown.json);
  });

  it('an anonymous visitor gets 401 from the API', async () => {
    expect((await rawRequest(port, { url: '/notes' })).status).toBe(401);
    expect((await rawRequest(port, { url: '/me' })).status).toBe(401);
  });

  it('/me shows the signed-in user and never the password hash', async () => {
    const call = await as('ann', 'user-password-1');
    const me = await call('GET', '/me');
    expect(me.status).toBe(200);
    expect(me.json.username).toBe('ann');
    expect(JSON.stringify(me.json)).not.toMatch(/password|hash/i);
  });

  it('a user without the permission can read notes but not write them', async () => {
    const call = await as('ann', 'user-password-1');
    expect((await call('GET', '/notes')).status).toBe(200);
    expect((await call('POST', '/notes', { body: 'x' })).status).toBe(403);
    expect((await call('DELETE', '/notes/1')).status).toBe(403);
  });

  it('an administrator creates, lists and deletes a note; bad input and unknown ids are refused', async () => {
    const call = await as('root', 'admin-password-1');
    const created = await call('POST', '/notes', { body: 'first note' });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ body: 'first note', author: 'root' });
    expect((await call('GET', '/notes')).json.map((n) => n.body)).toContain('first note');
    expect((await call('POST', '/notes', { body: '   ' })).status).toBe(400);
    expect((await call('DELETE', `/notes/${created.json.id}`)).status).toBe(200);
    expect((await call('DELETE', `/notes/${created.json.id}`)).status).toBe(404);
    expect((await call('DELETE', '/notes/abc')).status).toBe(404);
  });

  it('only an administrator reaches the admin panel', async () => {
    const user = await as('ann', 'user-password-1');
    expect([401, 403]).toContain((await user('GET', '/admin')).status);
    const admin = await as('root', 'admin-password-1');
    expect((await admin('GET', '/admin')).status).toBe(200);
  });

  it('a temporary password opens nothing but the password change, and the change unlocks everything', async () => {
    const res = await login('temp', 'temporary-password-1');
    expect(res.json.mustChangePassword).toBe(true);
    const cookie = cookieOf(res);
    const call = (method, url, body) => rawRequest(port, { method, url, headers: { origin, cookie }, body });
    const blocked = await call('GET', '/notes');
    expect(blocked.status).toBe(403);
    expect(blocked.json.error).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await call('POST', '/password/change', { newPassword: 'short' })).status).toBe(400);
    const changed = await call('POST', '/password/change', { newPassword: 'a-brand-new-password-9' });
    expect(changed.status).toBe(200);
    const fresh = cookieOf(changed);
    const after = await rawRequest(port, { url: '/notes', headers: { cookie: fresh } });
    expect(after.status).toBe(200);
  });

  it('signing out ends the session; a cross-origin POST is refused', async () => {
    const res = await login('ann', 'user-password-1');
    const cookie = cookieOf(res);
    const evil = await rawRequest(port, { method: 'POST', url: '/logout', headers: { origin: 'https://evil.example', cookie }, body: {} });
    expect(evil.status).toBe(403);
    expect((await rawRequest(port, { method: 'POST', url: '/logout', headers: { origin, cookie }, body: {} })).status).toBe(200);
    expect((await rawRequest(port, { url: '/me', headers: { cookie } })).status).toBe(401);
  });
});
