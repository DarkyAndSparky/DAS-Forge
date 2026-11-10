import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import nodeHttp from 'node:http';
import request from 'supertest';
import sharp from 'sharp';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { database, auth, config, branding, modules, audit } from '@das-forge/core';
import { createApp } from '../src/server.js';
import { createReportingModule } from '../src/modules/reporting-module.js';
import { seedAssetsIfEmpty } from '../src/records.js';
import { up as upAssetsTable } from '../migrations/002_assets.js';

/**
 * HTTP smoke test (audit D01): boots the REAL middleware stack from
 * server.js's createApp() - real Express 5, real cookie-parser, real
 * body parsing, real core/http middlewares, real argon2 - on an
 * ephemeral port and talks to it over an actual socket.
 *
 * routes.test.js deliberately stays as the fast layer (hand-written fake
 * app, SHA-256 password stand-in); it cannot see route ordering, real
 * Set-Cookie attributes, body-parser limits/errors, CSP headers or SSE
 * framing. This file covers exactly those.
 *
 * HONESTY NOTE: written in a sandbox with no network, so Express/argon2
 * could not be installed there and this file has NOT been executed by
 * its author - only the pieces it relies on (core/http middlewares,
 * routes.js against a fake app) were run. The first `npm test` on a
 * machine with real dependencies is its real verification; if an
 * assertion fails, treat it as a finding about either this file or the
 * app and report it as such.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function rawRequest(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (payload !== undefined) {
      h['content-length'] = Buffer.byteLength(payload);
      h['content-type'] = h['content-type'] ?? 'application/json';
    }
    const req = nodeHttp.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function sessionCookie(res) {
  const raw = [].concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('das_session='));
  return raw ? raw.split(';')[0].split('=')[1] : undefined;
}

describe('workshop over real HTTP (real Express, real middleware stack)', () => {
  let db, server, port, origin;

  beforeAll(async () => {
    const appConfig = config.validateConfig({
      appName: 'smoke',
      env: 'test',
      server: { host: '127.0.0.1', port: 3000, trustProxy: true, https: { mode: 'reverse-proxy' }, bodyLimit: '1kb' },
      security: {
        rateLimit: { windowMs: 60_000, max: 10_000 },
        loginRateLimit: { windowMs: 60_000, max: 10_000 },
      },
      auth: { sessionSecret: 'smoke-test-session-secret-0123456789' },
    });

    db = database.createSqliteAdapter({ file: ':memory:' });
    upAssetsTable(db);
    seedAssetsIfEmpty(db);

    const authProvider = auth.createAuthProvider({
      db,
      argon2Options: appConfig.auth.argon2,
    });

    const moduleRegistry = modules.createModuleRegistry();
    moduleRegistry.registerModule(createReportingModule({ db, findUserByIdFn: auth.findUserById, auditQueryFn: audit.query }));

    const vendorIdentity = branding.defineVendorIdentity({
      name: 'smoke',
      assetsDir: path.resolve(__dirname, '../assets/brand'),
    });

    for (const [username, password, role] of [
      ['alice', 'op-password-1', 'operator'],
      ['root', 'admin-password-1', 'admin'],
      ['victim', 'victim-password-1', 'operator'],
    ]) {
      auth.createUser(db, { username, passwordHash: await authProvider.hashPassword(password), role });
    }

    const { app } = createApp({
      appConfig,
      db,
      vendorIdentity,
      authProvider,
      runBackupJob: async () => [],
      moduleRegistry,
      uploadsDir: mkdtempSync(path.join(os.tmpdir(), 'workshop-smoke-')),
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

  const login = (username, password, headers = {}) =>
    rawRequest(port, { method: 'POST', url: '/login', headers: { origin, ...headers }, body: { username, password } });

  describe('headers and rendering', () => {
    it('GET /health answers 200 without a session and carries a request id + security headers', async () => {
      const res = await rawRequest(port, { url: '/health' });
      expect(res.status).toBe(200);
      expect(res.json.status).toBe('ok');
      expect(res.headers['x-request-id']).toBeTruthy();
      expect(res.headers['content-security-policy']).toContain("object-src 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('sends the full helmet-backed header set, drops X-Powered-By, and HSTS only behind an HTTPS proxy', async () => {
      const plain = await rawRequest(port, { url: '/health' });
      const h = plain.headers;
      expect(h['x-powered-by']).toBeUndefined();
      expect(h['x-frame-options']).toBe('DENY');
      expect(h['referrer-policy']).toBe('same-origin');
      expect(h['cross-origin-opener-policy']).toBe('same-origin');
      expect(h['cross-origin-resource-policy']).toBe('same-origin');
      expect(h['permissions-policy']).toContain('camera=()');
      expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(h['content-security-policy']).not.toContain('upgrade-insecure-requests');
      expect(h['strict-transport-security']).toBeUndefined();
      const https = await rawRequest(port, { url: '/health', headers: { 'x-forwarded-proto': 'https' } });
      expect(https.headers['strict-transport-security']).toContain('max-age=');
    });

    it('the CSP nonce in the header is the SAME nonce on the page\'s inline script (A01 wired end to end)', async () => {
      const res = await rawRequest(port, { url: '/login' });
      expect(res.status).toBe(200);
      const headerNonce = /'nonce-([^']+)'/.exec(res.headers['content-security-policy'])?.[1];
      expect(headerNonce).toBeTruthy();
      expect(res.text).toContain(`<script nonce="${headerNonce}">`);
      expect(res.text).not.toContain('<script>');
    });

    it('the password-reset pages are public, nonce-carrying, uncached and send no Referer', async () => {
      const forgot = await rawRequest(port, { url: '/forgot-password' });
      expect(forgot.status).toBe(200);
      const reset = await rawRequest(port, { url: '/reset-password' });
      expect(reset.status).toBe(200);
      expect(reset.headers['referrer-policy']).toBe('no-referrer');
      expect(reset.headers['cache-control']).toContain('no-store');
      const nonce = /'nonce-([^']+)'/.exec(reset.headers['content-security-policy'])?.[1];
      expect(reset.text).toContain(`<script nonce="${nonce}">`);
    });

    it('every response gets its own nonce', async () => {
      const a = await rawRequest(port, { url: '/login' });
      const b = await rawRequest(port, { url: '/login' });
      const n = (r) => /'nonce-([^']+)'/.exec(r.headers['content-security-policy'])[1];
      expect(n(a)).not.toBe(n(b));
    });

    it('an unknown route gets the branded 404 page, still with the security headers', async () => {
      const res = await rawRequest(port, { url: '/definitely-not-a-route' });
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['content-security-policy']).toBeTruthy();
    });

    it('replaces a malformed incoming X-Request-Id instead of echoing it (A17)', async () => {
      const res = await rawRequest(port, { url: '/health', headers: { 'x-request-id': 'bad id!' } });
      expect(res.headers['x-request-id']).not.toBe('bad id!');
      const ok = await rawRequest(port, { url: '/health', headers: { 'x-request-id': 'trace-abc-12345' } });
      expect(ok.headers['x-request-id']).toBe('trace-abc-12345');
    });
  });

  describe('session cookie attributes', () => {
    it('is HttpOnly + SameSite=Lax, and Secure when the trusted proxy says the request was HTTPS', async () => {
      const res = await login('alice', 'op-password-1', { 'x-forwarded-proto': 'https' });
      expect(res.status).toBe(200);
      const cookie = [].concat(res.headers['set-cookie']).find((c) => c.startsWith('das_session='));
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Secure');
    });

    it('is NOT marked Secure when the proxy reports plain HTTP (reverse-proxy mode relies on req.secure)', async () => {
      const res = await login('alice', 'op-password-1', { 'x-forwarded-proto': 'http' });
      const cookie = [].concat(res.headers['set-cookie']).find((c) => c.startsWith('das_session='));
      expect(cookie).not.toContain('Secure');
    });
  });

  describe('CSRF (A03)', () => {
    it('rejects a cross-origin login POST with 403 and sets no cookie', async () => {
      const res = await rawRequest(port, {
        method: 'POST',
        url: '/login',
        headers: { origin: 'https://evil.example' },
        body: { username: 'alice', password: 'op-password-1' },
      });
      expect(res.status).toBe(403);
      expect(res.json.error).toBe('CSRF_REJECTED');
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('rejects a cookie-carrying POST that has no Origin/Referer/Fetch-Metadata at all', async () => {
      const cookie = sessionCookie(await login('alice', 'op-password-1'));
      const res = await rawRequest(port, { method: 'POST', url: '/logout', headers: { cookie: `das_session=${cookie}` }, body: {} });
      expect(res.status).toBe(403);
    });

    it('allows the same POST when the Origin matches the host', async () => {
      const cookie = sessionCookie(await login('alice', 'op-password-1'));
      const res = await rawRequest(port, { method: 'POST', url: '/logout', headers: { origin, cookie: `das_session=${cookie}` }, body: {} });
      expect(res.status).toBe(200);
    });

    it('does not interfere with GET requests', async () => {
      const cookie = sessionCookie(await login('alice', 'op-password-1'));
      const res = await rawRequest(port, { url: '/me', headers: { cookie: `das_session=${cookie}`, origin: 'https://evil.example' } });
      expect(res.status).toBe(200);
      expect(res.json.username).toBe('alice');
    });
  });

  describe('logo upload over multipart (multer, supertest)', () => {
    const logoRequest = (cookie) => {
      const r = request(origin).post('/assets/1/logo').set('Origin', origin);
      return cookie ? r.set('Cookie', `das_session=${cookie}`) : r;
    };
    const png = () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#cc3300' } }).png().toBuffer();

    it('needs a session', async () => {
      const res = await logoRequest().attach('logo', Buffer.from('x'), 'a.png');
      expect(res.status).toBe(401);
    });

    it('a real PNG is accepted, re-encoded and recorded', async () => {
      const cookie = sessionCookie(await login('alice', 'op-password-1'));
      const res = await logoRequest(cookie).attach('logo', await png(), { filename: 'logo.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      expect(res.body.detectedType).toBe('png');
    });

    it('a body that is not multipart is 415', async () => {
      const cookie = sessionCookie(await login('alice', 'op-password-1'));
      const res = await logoRequest(cookie).set('Content-Type', 'image/png').send(await png());
      expect(res.status).toBe(415);
      expect(res.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('a file under the wrong form field, and a form with no file, are 400', async () => {
      const cookie = sessionCookie(await login('alice', 'op-password-1'));
      const wrong = await logoRequest(cookie).attach('other', await png(), 'logo.png');
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toBe('UNEXPECTED_FIELD');
      const none = await logoRequest(cookie).field('note', 'hi');
      expect(none.status).toBe(400);
      expect(none.body.error).toBe('NO_FILE');
    });

    it('the claimed content type is not trusted: HTML labelled image/png is refused by the magic-byte check', async () => {
      const cookie = sessionCookie(await login('alice', 'op-password-1'));
      const res = await logoRequest(cookie).attach('logo', Buffer.from('<html>not a png</html>'), { filename: 'a.png', contentType: 'image/png' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_UPLOAD');
    });

    it('a file over the 2 MB limit is 413 FILE_TOO_LARGE', async () => {
      const cookie = sessionCookie(await login('alice', 'op-password-1'));
      const res = await logoRequest(cookie).attach('logo', Buffer.alloc(2 * 1024 * 1024 + 1024, 1), { filename: 'big.png', contentType: 'image/png' });
      expect(res.status).toBe(413);
      expect(res.body.error).toBe('FILE_TOO_LARGE');
    });
  });

  describe('signed session cookie (express-session, audit A11)', () => {
    const me = (cookie) => rawRequest(port, { url: '/me', headers: { cookie: `das_session=${cookie}` } });

    it('the cookie is signed (s:<id>.<signature>) and works as issued', async () => {
      const cookie = sessionCookie(await login('alice', 'op-password-1'));
      const decoded = decodeURIComponent(cookie);
      expect(decoded.startsWith('s:')).toBe(true);
      expect(decoded.includes('.')).toBe(true);
      expect((await me(cookie)).status).toBe(200);
    });

    it('a tampered signature and a bare session id are both anonymous', async () => {
      const cookie = decodeURIComponent(sessionCookie(await login('alice', 'op-password-1')));
      const sid = cookie.slice(2, cookie.lastIndexOf('.'));
      expect((await me(encodeURIComponent(`${cookie.slice(0, -2)}xx`))).status).toBe(401);
      expect((await me(sid)).status).toBe(401);
      expect((await me(encodeURIComponent(`s:${sid}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`))).status).toBe(401);
    });

    it('the database holds only hashes of session ids, never the cookie value', async () => {
      const cookie = decodeURIComponent(sessionCookie(await login('alice', 'op-password-1')));
      const sid = cookie.slice(2, cookie.lastIndexOf('.'));
      const ids = db.all('SELECT id FROM sessions').map((r) => r.id);
      expect(ids.includes(sid)).toBe(false);
      expect(ids.every((id) => id.startsWith('h1:'))).toBe(true);
    });

    it('logout ends the session on the server: the old cookie is dead afterwards', async () => {
      const cookie = sessionCookie(await login('alice', 'op-password-1'));
      const out = await rawRequest(port, { method: 'POST', url: '/logout', headers: { origin, cookie: `das_session=${cookie}` }, body: {} });
      expect(out.status).toBe(200);
      expect((await me(cookie)).status).toBe(401);
    });

    it('logging in again replaces the id and kills the previous session (A13, fixation)', async () => {
      const first = sessionCookie(await login('alice', 'op-password-1'));
      const second = sessionCookie(await login('alice', 'op-password-1', { cookie: `das_session=${first}` }));
      expect(second).not.toBe(first);
      expect((await me(first)).status).toBe(401);
      expect((await me(second)).status).toBe(200);
    });
  });

  describe('authentication over the wire', () => {
    it('the root sends a signed-out visitor to /login; favicon.ico is a quiet 204', async () => {
      const root = await rawRequest(port, { url: '/' });
      expect(root.status).toBe(302);
      expect(root.headers.location).toBe('/login');
      expect((await rawRequest(port, { url: '/favicon.ico' })).status).toBe(204);
    });

    it('a protected route without a session is 401 JSON', async () => {
      const res = await rawRequest(port, { url: '/assets' });
      expect(res.status).toBe(401);
      expect(res.json.error).toBe('UNAUTHENTICATED');
    });

    it('locks a username after 5 wrong passwords, with Retry-After (real argon2, real sockets)', async () => {
      for (let i = 0; i < 5; i++) {
        const r = await login('victim', `wrong-${i}`);
        expect(r.status).toBe(401);
      }
      const locked = await login('victim', 'victim-password-1');
      expect(locked.status).toBe(429);
      expect(locked.json.error).toBe('TOO_MANY_ATTEMPTS');
      expect(locked.headers['retry-after']).toBeTruthy();
    });
  });

  describe('request body handling', () => {
    it('rejects a JSON body over server.bodyLimit with 413', async () => {
      const res = await rawRequest(port, {
        method: 'POST',
        url: '/login',
        headers: { origin },
        body: { username: 'alice', password: 'x'.repeat(4_000) },
      });
      expect(res.status).toBe(413);
    });

    it('answers malformed JSON with a 4xx, not a crash', async () => {
      const res = await rawRequest(port, { method: 'POST', url: '/login', headers: { origin }, body: '{"username": ' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThanOrEqual(499);
    });
  });

  describe('SSE', () => {
    it('streams text/event-stream with an initial "connected" event and cleans up on close', async () => {
      const cookie = sessionCookie(await login('root', 'admin-password-1'));
      const firstChunk = await new Promise((resolve, reject) => {
        const req = nodeHttp.get(
          { host: '127.0.0.1', port, path: '/events/lab', headers: { cookie: `das_session=${cookie}`, accept: 'text/event-stream' } },
          (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/event-stream');
            res.setEncoding('utf8');
            res.once('data', (chunk) => {
              req.destroy();
              resolve(chunk);
            });
          }
        );
        req.on('error', (err) => {
          // destroy() after we got what we needed surfaces as ECONNRESET - not a failure
          if (err.code !== 'ECONNRESET') reject(err);
        });
      });
      expect(firstChunk).toContain('connected');
    });

    it('refuses an unauthenticated SSE subscription', async () => {
      const res = await rawRequest(port, { url: '/events/lab' });
      expect(res.status).toBe(401);
    });
  });
});
