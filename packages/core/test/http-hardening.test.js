import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRateLimiter, createFailureTracker } from '../src/http/rate-limit.js';
import { csrfProtection } from '../src/http/csrf.js';
import { requestId, securityHeaders, registerGracefulShutdown } from '../src/http/bootstrap.js';
import {
  applyServerSettings,
  secureCookiePolicy,
  loadOrCreateTls,
  createHttpServer,
  listenServer,
} from '../src/http/server.js';

/** Header bag that ignores name case (helmet and hand-written code may spell names differently). */
function caseInsensitiveHeaders() {
  const store = new Map();
  return new Proxy({}, {
    get: (_t, k) => (typeof k === 'string' ? store.get(k.toLowerCase()) : undefined),
    set: (_t, k, v) => { store.set(String(k).toLowerCase(), v); return true; },
    deleteProperty: (_t, k) => { store.delete(String(k).toLowerCase()); return true; },
    has: (_t, k) => store.has(String(k).toLowerCase()),
  });
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: caseInsensitiveHeaders(),
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    getHeader(name) {
      return this.headers[name];
    },
    removeHeader(name) {
      delete this.headers[name];
    },
  };
  return res;
}

describe('createRateLimiter (express-rate-limit)', () => {
  it('allows up to max requests per window, then answers 429 with Retry-After', async () => {
    const limit = createRateLimiter({ windowMs: 60_000, max: 3 });
    const next = vi.fn();
    for (let i = 0; i < 3; i++) await limit({ ip: '1.1.1.1' }, mockRes(), next);
    expect(next).toHaveBeenCalledTimes(3);

    const res = mockRes();
    await limit({ ip: '1.1.1.1' }, res, next);
    expect(next).toHaveBeenCalledTimes(3);
    expect(res.statusCode).toBe(429);
    expect(res.body.error).toBe('RATE_LIMITED');
    expect(res.headers['Retry-After']).toBe('60');
    expect(res.body.retryAfterSec).toBe(60);
  });

  it('starts a fresh window once windowMs has passed', async () => {
    vi.useFakeTimers();
    try {
      const limit = createRateLimiter({ windowMs: 1_000, max: 1 });
      const next = vi.fn();
      await limit({ ip: 'a' }, mockRes(), next);
      const blocked = mockRes();
      await limit({ ip: 'a' }, blocked, next);
      expect(blocked.statusCode).toBe(429);
      await vi.advanceTimersByTimeAsync(1_001);
      await limit({ ip: 'a' }, mockRes(), next);
      expect(next).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps separate budgets per key', async () => {
    const limit = createRateLimiter({ windowMs: 60_000, max: 1 });
    const next = vi.fn();
    await limit({ ip: 'a' }, mockRes(), next);
    await limit({ ip: 'b' }, mockRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('honours a custom keyFn', async () => {
    const limit = createRateLimiter({ windowMs: 60_000, max: 1, keyFn: (req) => req.body.username });
    const next = vi.fn();
    await limit({ ip: 'x', body: { username: 'alice' } }, mockRes(), next);
    const res = mockRes();
    await limit({ ip: 'y', body: { username: 'alice' } }, res, next);
    expect(res.statusCode).toBe(429);
  });

  it('reset(key) forgets a key', async () => {
    const limit = createRateLimiter({ windowMs: 60_000, max: 1 });
    const next = vi.fn();
    await limit({ ip: 'a' }, mockRes(), next);
    limit.reset('a');
    await limit({ ip: 'a' }, mockRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('pools requests that have no ip under one key instead of failing', async () => {
    const limit = createRateLimiter({ windowMs: 60_000, max: 1 });
    const next = vi.fn();
    await limit({}, mockRes(), next);
    const res = mockRes();
    await limit({}, res, next);
    expect(res.statusCode).toBe(429);
  });

  it('rejects nonsensical options up front', () => {
    expect(() => createRateLimiter({ windowMs: 0, max: 1 })).toThrow();
    expect(() => createRateLimiter({ windowMs: 1000, max: 0 })).toThrow();
    expect(() => createRateLimiter({ windowMs: 1.5, max: 1 })).toThrow();
  });
});

describe('createFailureTracker', () => {
  it('does not lock before maxFailures and locks exactly at it', () => {
    const tr = createFailureTracker({ maxFailures: 3, baseLockMs: 1_000, now: () => 0 });
    expect(tr.recordFailure('k').locked).toBe(false);
    expect(tr.recordFailure('k').locked).toBe(false);
    expect(tr.check('k').locked).toBe(false);
    const third = tr.recordFailure('k');
    expect(third.locked).toBe(true);
    expect(third.retryAfterMs).toBe(1_000);
    expect(tr.check('k').locked).toBe(true);
  });

  it('doubles the lock on each further failure, capped at maxLockMs', () => {
    let t = 0;
    const tr = createFailureTracker({ maxFailures: 2, baseLockMs: 1_000, maxLockMs: 3_500, now: () => t });
    tr.recordFailure('k');
    expect(tr.recordFailure('k').retryAfterMs).toBe(1_000); // 2nd failure: base
    t = 1_001; // lock expired
    expect(tr.check('k').locked).toBe(false);
    expect(tr.recordFailure('k').retryAfterMs).toBe(2_000); // 3rd: 2x
    t += 2_001;
    expect(tr.recordFailure('k').retryAfterMs).toBe(3_500); // 4th: 4x would be 4000, capped
  });

  it('check() reports remaining time and the lock expires', () => {
    let t = 0;
    const tr = createFailureTracker({ maxFailures: 1, baseLockMs: 10_000, now: () => t });
    tr.recordFailure('k');
    t = 4_000;
    expect(tr.check('k')).toEqual({ locked: true, retryAfterMs: 6_000 });
    t = 10_000;
    expect(tr.check('k').locked).toBe(false);
  });

  it('reset() clears the state after a success', () => {
    const tr = createFailureTracker({ maxFailures: 2, now: () => 0 });
    tr.recordFailure('k');
    tr.recordFailure('k');
    expect(tr.check('k').locked).toBe(true);
    tr.reset('k');
    expect(tr.check('k').locked).toBe(false);
    expect(tr.recordFailure('k').failures).toBe(1);
  });

  it('forgets old failures after resetAfterMs of quiet', () => {
    let t = 0;
    const tr = createFailureTracker({ maxFailures: 3, resetAfterMs: 1_000, now: () => t });
    tr.recordFailure('k');
    tr.recordFailure('k');
    t = 5_000;
    // two stale failures must not count towards the next lock
    expect(tr.recordFailure('k').failures).toBe(1);
  });

  it('tracks keys independently and caps memory', () => {
    const tr = createFailureTracker({ maxFailures: 1, now: () => 0, maxKeys: 5 });
    tr.recordFailure('a');
    expect(tr.check('b').locked).toBe(false);
    for (let i = 0; i < 50; i++) tr.recordFailure(`k${i}`);
    expect(tr.size()).toBeLessThanOrEqual(5);
  });
});

describe('csrfProtection', () => {
  function run(opts, req) {
    const mw = csrfProtection(opts);
    const res = mockRes();
    const next = vi.fn();
    mw({ method: 'POST', path: '/x', headers: {}, cookies: {}, ...req }, res, next);
    return { res, passed: next.mock.calls.length === 1 };
  }

  it('strictPaths refuse a request with no browser signal even without a cookie (K06)', () => {
    const opts = { strictPaths: ['/login'] };
    expect(run(opts, { path: '/login' }).passed).toBe(false);
    expect(run(opts, { path: '/login', headers: { host: 'app.example', origin: 'https://app.example' } }).passed).toBe(true);
    expect(run(opts, { path: '/other' }).passed).toBe(true);
    expect(run({}, { path: '/login' }).passed).toBe(true);
  });

  it('lets safe methods through untouched', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(run({}, { method, headers: { origin: 'https://evil.example', host: 'app.example' } }).passed).toBe(true);
    }
  });

  it('accepts a POST whose Origin matches the Host', () => {
    expect(run({}, { headers: { host: 'app.example:4321', origin: 'https://app.example:4321' } }).passed).toBe(true);
  });

  it('rejects a POST from another origin with 403 CSRF_REJECTED', () => {
    const { res, passed } = run({}, { headers: { host: 'app.example', origin: 'https://evil.example' } });
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('CSRF_REJECTED');
  });

  it('rejects the opaque origin "null" and unparsable origins', () => {
    expect(run({}, { headers: { host: 'a', origin: 'null' } }).passed).toBe(false);
    expect(run({}, { headers: { host: 'a', origin: 'not a url' } }).passed).toBe(false);
  });

  it('rejects Sec-Fetch-Site: cross-site even when Origin looks fine', () => {
    expect(
      run({}, { headers: { host: 'a.example', origin: 'https://a.example', 'sec-fetch-site': 'cross-site' } }).passed
    ).toBe(false);
  });

  it('accepts same-origin/none via Fetch Metadata when no Origin is sent, rejects same-site', () => {
    expect(run({}, { headers: { 'sec-fetch-site': 'same-origin' } }).passed).toBe(true);
    expect(run({}, { headers: { 'sec-fetch-site': 'none' } }).passed).toBe(true);
    expect(run({}, { headers: { 'sec-fetch-site': 'same-site' } }).passed).toBe(false);
  });

  it('falls back to Referer when there is no Origin or Fetch Metadata', () => {
    expect(run({}, { headers: { host: 'a.example', referer: 'https://a.example/page' } }).passed).toBe(true);
    expect(run({}, { headers: { host: 'a.example', referer: 'https://evil.example/page' } }).passed).toBe(false);
  });

  it('blocks a cookie-carrying request with no origin signal, allows a cookie-less one', () => {
    expect(run({}, { cookies: { das_session: 'abc' } }).passed).toBe(false);
    expect(run({}, { cookies: {} }).passed).toBe(true);
  });

  it('uses the configured session cookie name for that last check', () => {
    expect(run({ sessionCookieName: 'sid' }, { cookies: { sid: 'x' } }).passed).toBe(false);
    expect(run({ sessionCookieName: 'sid' }, { cookies: { das_session: 'x' } }).passed).toBe(true);
  });

  it('allows explicitly trusted origins', () => {
    const opts = { trustedOrigins: ['https://admin.example.com/'] };
    expect(run(opts, { headers: { host: 'api.example.com', origin: 'https://admin.example.com' } }).passed).toBe(true);
    expect(run(opts, { headers: { host: 'api.example.com', origin: 'https://other.example.com' } }).passed).toBe(false);
  });

  it('only trusts X-Forwarded-Host when trustProxy is on', () => {
    const headers = { host: 'internal:3000', 'x-forwarded-host': 'public.example', origin: 'https://public.example' };
    expect(run({ trustProxy: true }, { headers }).passed).toBe(true);
    expect(run({ trustProxy: false }, { headers }).passed).toBe(false);
  });

  it('skips exempt paths entirely', () => {
    const opts = { exemptPaths: ['/webhooks/bitrix'] };
    expect(run(opts, { path: '/webhooks/bitrix', headers: { origin: 'https://evil.example', host: 'a' } }).passed).toBe(true);
    expect(run(opts, { path: '/other', headers: { origin: 'https://evil.example', host: 'a' } }).passed).toBe(false);
  });
});

describe('requestId hardening', () => {
  function id(headerValue) {
    const req = { headers: headerValue === undefined ? {} : { 'x-request-id': headerValue } };
    requestId()(req, mockRes(), () => {});
    return req.id;
  }

  it('keeps a well-formed incoming id', () => {
    expect(id('trace-1234.abc_9')).toBe('trace-1234.abc_9');
  });

  it('replaces too-short, too-long or odd-character ids with a fresh one', () => {
    expect(id('short')).not.toBe('short');
    const long = 'a'.repeat(65);
    expect(id(long)).not.toBe(long);
    expect(id('has space in it')).not.toBe('has space in it');
    expect(id('<script>alert(1)</script>')).not.toBe('<script>alert(1)</script>');
  });
});

describe('securityHeaders (nonce, HSTS, extra directives)', () => {
  function headersFor(opts, req = {}) {
    const res = mockRes();
    securityHeaders(opts)(req, res, () => {});
    return { res, req };
  }

  it('puts a per-request nonce in the CSP and exposes it on res.locals and req', () => {
    const { res, req } = headersFor();
    const csp = res.headers['Content-Security-Policy'];
    const nonce = res.locals.cspNonce;
    expect(nonce.length).toBeGreaterThanOrEqual(16);
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(req.cspNonce).toBe(nonce);
    expect(csp).not.toContain("'unsafe-inline' 'nonce");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it('generates a different nonce for every request', () => {
    const a = headersFor().res.locals.cspNonce;
    const b = headersFor().res.locals.cspNonce;
    expect(a).not.toBe(b);
  });

  it('adds object-src, base-uri, form-action and frame-ancestors restrictions', () => {
    const csp = headersFor().res.headers['Content-Security-Policy'];
    for (const d of ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) {
      expect(csp).toContain(d);
    }
  });

  it('sends HSTS only over HTTPS requests', () => {
    expect(headersFor({}, { secure: true }).res.headers['Strict-Transport-Security']).toBe('max-age=31536000');
    expect(headersFor({}, { secure: false }).res.headers['Strict-Transport-Security']).toBeUndefined();
  });

  it('supports includeSubDomains, custom max-age, and hsts:false', () => {
    const custom = headersFor({ hsts: { maxAgeSeconds: 100, includeSubDomains: true } }, { secure: true });
    expect(custom.res.headers['Strict-Transport-Security']).toBe('max-age=100; includeSubDomains');
    const off = headersFor({ hsts: false }, { secure: true });
    expect(off.res.headers['Strict-Transport-Security']).toBeUndefined();
  });

  it('sets the other hardening headers', () => {
    const h = headersFor().res.headers;
    expect(h['Permissions-Policy']).toContain('camera=()');
    expect(h['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(h['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
  });
});

describe('registerGracefulShutdown', () => {
  function fakeServer({ closeCallsBack = true } = {}) {
    return {
      close: vi.fn((cb) => closeCallsBack && cb()),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };
  }

  it('runs onDrainStart, closes the server, runs onShutdown, then exits 0', async () => {
    const order = [];
    const server = fakeServer();
    server.close = vi.fn((cb) => {
      order.push('close');
      cb();
    });
    const exit = vi.fn();
    const { shutdown } = registerGracefulShutdown(server, {
      signals: [],
      exit,
      onDrainStart: () => order.push('drainStart'),
      onShutdown: () => order.push('shutdown'),
    });
    await shutdown('SIGTERM');
    expect(order).toEqual(['drainStart', 'close', 'shutdown']);
    expect(server.closeIdleConnections).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when onShutdown throws (no longer masked by exit 0)', async () => {
    const exit = vi.fn();
    const { shutdown } = registerGracefulShutdown(fakeServer(), {
      signals: [],
      exit,
      onShutdown: () => {
        throw new Error('db close failed');
      },
    });
    await shutdown('SIGINT');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('is idempotent: a second signal does not run shutdown twice', async () => {
    const exit = vi.fn();
    const onShutdown = vi.fn();
    const { shutdown } = registerGracefulShutdown(fakeServer(), { signals: [], exit, onShutdown });
    await shutdown('SIGTERM');
    await shutdown('SIGTERM');
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('server settings', () => {
  function fakeApp() {
    const settings = {};
    const disabled = [];
    return { settings, disabled, set: (k, v) => (settings[k] = v), disable: (k) => disabled.push(k) };
  }

  it('refuses reverse-proxy mode without trustProxy', () => {
    expect(() => applyServerSettings(fakeApp(), { https: { mode: 'reverse-proxy' }, trustProxy: false })).toThrow(/trustProxy/);
  });

  it('sets trust proxy to one hop (not `true`) and disables x-powered-by', () => {
    const app = fakeApp();
    applyServerSettings(app, { https: { mode: 'reverse-proxy' }, trustProxy: true });
    expect(app.settings['trust proxy']).toBe(1);
    expect(app.disabled).toContain('x-powered-by');
  });

  it('keeps trust proxy off when not configured', () => {
    const app = fakeApp();
    applyServerSettings(app, { https: { mode: 'self-signed' }, trustProxy: false });
    expect(app.settings['trust proxy']).toBe(false);
  });

  it('marks cookies Secure always when terminating TLS, from req.secure behind a proxy', () => {
    expect(secureCookiePolicy({ https: { mode: 'self-signed' } })({ secure: false })).toBe(true);
    expect(secureCookiePolicy({ https: { mode: 'standalone' } })({ secure: false })).toBe(true);
    const behind = secureCookiePolicy({ https: { mode: 'reverse-proxy' } });
    expect(behind({ secure: true })).toBe(true);
    expect(behind({ secure: false })).toBe(false);
  });

  it('reverse-proxy mode needs no TLS credentials and applies the timeouts', () => {
    const server = createHttpServer(() => {}, { serverConfig: { https: { mode: 'reverse-proxy' }, requestTimeoutMs: 12_345 } });
    expect(server.requestTimeout).toBe(12_345);
    expect(server.headersTimeout).toBeLessThanOrEqual(12_345);
  });

  it('refuses to build a TLS mode server without credentials', () => {
    expect(() => createHttpServer(() => {}, { serverConfig: { https: { mode: 'self-signed' } } })).toThrow(/TLS credentials/);
  });

  it('standalone mode requires both certPath and keyPath', async () => {
    await expect(loadOrCreateTls({ serverConfig: { https: { mode: 'standalone', certPath: 'x' } }, certDir: '.' })).rejects.toThrow(/certPath\/keyPath/);
  });

  it('reverse-proxy mode loads no TLS credentials', async () => {
    expect(await loadOrCreateTls({ serverConfig: { https: { mode: 'reverse-proxy' } }, certDir: '.' })).toBeNull();
  });

  it('self-signed mode generates a cert once, then reuses the files', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'das-tls-'));
    const generateSelfSignedCert = vi.fn(async () => ({ cert: 'CERT-PEM', key: 'KEY-PEM' }));
    const certs = {
      generateSelfSignedCert,
      certFilePaths: (d) => ({ certPath: path.join(d, 'cert.pem'), keyPath: path.join(d, 'key.pem') }),
      writeCertFiles: (d, { cert, key }) => {
        const p = { certPath: path.join(d, 'cert.pem'), keyPath: path.join(d, 'key.pem') };
        writeFileSync(p.certPath, cert);
        writeFileSync(p.keyPath, key);
        return p;
      },
    };
    const cfg = { https: { mode: 'self-signed' } };
    const first = await loadOrCreateTls({ serverConfig: cfg, certDir: dir, certs });
    expect(String(first.cert)).toBe('CERT-PEM');
    expect(existsSync(path.join(dir, 'key.pem'))).toBe(true);
    await loadOrCreateTls({ serverConfig: cfg, certDir: dir, certs });
    expect(generateSelfSignedCert).toHaveBeenCalledTimes(1);
  });

  it('self-signed mode without a certs module is a clear programming error', async () => {
    await expect(loadOrCreateTls({ serverConfig: { https: { mode: 'self-signed' } }, certDir: '.' })).rejects.toThrow(/certs/);
  });
});

describe('over a real HTTP socket (no Express needed)', () => {
  /** Minimal connect-style runner so the real middlewares run against
   * real node:http requests: res.status()/json() shims over ServerResponse. */
  function startServer(middlewares, finalHandler) {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      req.path = url.pathname;
      req.ip = req.socket.remoteAddress;
      req.cookies = Object.fromEntries(
        (req.headers.cookie ?? '')
          .split(';')
          .filter(Boolean)
          .map((c) => c.trim().split('='))
      );
      res.status = (code) => {
        res.statusCode = code;
        return res;
      };
      res.json = (payload) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      let i = 0;
      const next = () => {
        const mw = middlewares[i++];
        if (mw) return mw(req, res, next);
        return finalHandler(req, res);
      };
      next();
    });
    return listenServer(server, { host: '127.0.0.1', port: 0 }).then((addr) => ({ server, port: addr.port }));
  }

  function rawRequest(port, { method = 'GET', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: '/', headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('answers 429 + Retry-After once the limit is exceeded', async () => {
    const limit = createRateLimiter({ windowMs: 60_000, max: 2 });
    const { server, port } = await startServer([limit], (req, res) => res.json({ ok: true }));
    try {
      expect((await rawRequest(port)).status).toBe(200);
      expect((await rawRequest(port)).status).toBe(200);
      const third = await rawRequest(port);
      expect(third.status).toBe(429);
      expect(third.headers['retry-after']).toBeTruthy();
      expect(JSON.parse(third.body).error).toBe('RATE_LIMITED');
    } finally {
      server.close();
    }
  });

  it('CSRF: blocks a cross-origin POST and allows a same-origin one on the wire', async () => {
    const { server, port } = await startServer([csrfProtection()], (req, res) => res.json({ ok: true }));
    try {
      const host = `127.0.0.1:${port}`;
      const evil = await rawRequest(port, { method: 'POST', headers: { origin: 'https://evil.example' } });
      expect(evil.status).toBe(403);
      const same = await rawRequest(port, { method: 'POST', headers: { origin: `http://${host}` } });
      expect(same.status).toBe(200);
      const cookieNoOrigin = await rawRequest(port, { method: 'POST', headers: { cookie: 'das_session=abc' } });
      expect(cookieNoOrigin.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('securityHeaders: the nonce in the CSP header differs per real response', async () => {
    const { server, port } = await startServer([securityHeaders()], (req, res) => res.json({ nonce: req.cspNonce }));
    try {
      const a = await rawRequest(port);
      const b = await rawRequest(port);
      const nonceA = JSON.parse(a.body).nonce;
      expect(a.headers['content-security-policy']).toContain(`'nonce-${nonceA}'`);
      expect(nonceA).not.toBe(JSON.parse(b.body).nonce);
    } finally {
      server.close();
    }
  });

  it('listenServer binds the configured host and rejects on a busy port', async () => {
    const { server, port } = await startServer([], (req, res) => res.json({}));
    try {
      const second = http.createServer();
      await expect(listenServer(second, { host: '127.0.0.1', port })).rejects.toThrow(/EADDRINUSE|address already in use/);
    } finally {
      server.close();
    }
  });
});
