import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { database, auth, modules, http, audit, security } from '@das-forge/core';
import { registerRoutes } from '../src/routes.js';
import { createReportingModule } from '../src/modules/reporting-module.js';
import { seedAssetsIfEmpty } from '../src/records.js';
import { up as upAssetsTable } from '../migrations/002_assets.js';
import { createFakeExpressSession } from './helpers/fake-express-session.js';

/**
 * Stage B (Users & Access) route tests.
 *
 * Runs registerRoutes() against a REAL node:sqlite db and the REAL
 * core/auth session/TOTP/authenticator logic - no stand-ins for any of
 * that. The one thing this sandbox genuinely cannot exercise is
 * argon2id itself (no network here to install the native package, see
 * docs/roadmap.md's standing methodology note) - password hashing/
 * verification below uses a plain SHA-256 stand-in authProvider
 * instead of core/auth's real hashPassword/verifyPassword, so these
 * tests prove routes.js's REQUEST-HANDLING LOGIC (status codes, session
 * state machine, permission checks) is correct, not that argon2 itself
 * works - that half is already covered by packages/core's own
 * auth.test.js, and needs the user's real `npm test` to confirm this
 * app's wiring survives real argon2 end to end (same honesty rule as
 * every other module in this repo).
 *
 * express/cookie-parser are peerDependencies of @das-forge/core, not
 * installed in this no-network sandbox either, so there's no real HTTP
 * server here - instead, a minimal fake `app` records route
 * registrations (method, path, middleware chain) and a `dispatch()`
 * helper runs a fake req/res through the matching chain exactly like
 * Express would, including stopping at the first middleware that
 * doesn't call next(). This exercises the full handler chain
 * (validateBody → requireAuth → requirePermission → handler) for real,
 * just without a socket underneath it.
 *
 * Found via the user's FIRST real run of this file (0.1.19, Windows):
 * 27/37 failed, every one of them a 401 where some other status was
 * expected. Root cause was this harness, not routes.js - in the real
 * app, server.js mounts `http.sessionMiddleware({authProvider})`
 * GLOBALLY, ahead of every route, and that's the ONLY place req.user
 * gets set (see session-middleware.js's own doc comment). This
 * harness's dispatch() only ever ran a route's OWN handler chain
 * (`app.get(path, requireAuth(), handler)`), never anything mounted
 * globally - so requireAuth() always saw `req.user` as `undefined` and
 * rejected with 401, regardless of whether a valid session cookie was
 * sent. Fixed with a real `app.use()` (`harness.app.use(...)`,
 * `createFakeApp()` below) whose middlewares dispatch() now runs
 * ahead of the matched route's own chain, exactly like Express's
 * mount order - and `makeFakeAuthProvider()` gained a real
 * `verifySession()` (core/auth's own `verifySession(db, id)` - no
 * stand-in needed, it's pure `node:sqlite` logic, not argon2) for
 * `sessionMiddleware` to call.
 */

import { createHash } from 'node:crypto';

function fakeHash(plain) {
  return `sha256:${createHash('sha256').update(plain).digest('hex')}`;
}

function makeFakeAuthProvider(db) {
  return {
    hashPassword: async (plain) => fakeHash(plain),
    verifyPassword: async (stored, plain) => ({ valid: stored === fakeHash(plain), scheme: 'fake', needsRehash: false }),
  };
}

/**
 * What server.js mounts for sessions: express-session (stand-in, see helpers/) on the REAL
 * core SQLite store, then attachUser(). The only place req.user gets set.
 */
function fakeSessionMiddlewares(db) {
  const expressSession = createFakeExpressSession();
  const ttlMs = 8 * 60 * 60 * 1000;
  const store = auth.createSessionStore({ db, expressSession, ttlMs });
  return [
    http.createSessionMiddleware({ store, secret: 'routes-test-session-secret-0123456789', ttlMs, expressSession }),
    http.attachUser(),
  ];
}

function createFakeApp() {
  const routes = []; // { method, path: RegExp, paramNames, handlers }
  // Middlewares registered via app.use() - mirrors Express's own mount
  // order (server.js's cookieParser/sessionMiddleware/etc run ahead of
  // EVERY route), so dispatch() below runs these first, then the
  // matched route's own handler chain - see the header comment above
  // for why this split matters (it's the fix for the first real `npm
  // test` run's 27 failures, all 401s from a missing req.user).
  const globalMiddlewares = [];

  function pathToMatcher(path) {
    const paramNames = [];
    const pattern = path
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          paramNames.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    return { regex: new RegExp(`^${pattern}$`), paramNames };
  }

  function register(method) {
    return (path, ...handlers) => {
      const { regex, paramNames } = pathToMatcher(path);
      routes.push({ method, regex, paramNames, handlers });
    };
  }

  const app = {
    get: register('get'),
    post: register('post'),
    patch: register('patch'),
    delete: register('delete'),
    use: (...middlewares) => globalMiddlewares.push(...middlewares),
  };

  /**
   * Runs method+path+body/cookies through app.use()'s global
   * middlewares FIRST, then the matched route's own middleware chain -
   * same mount order Express itself uses (server.js's global `app.use`
   * calls, then registerRoutes()'s per-route ones).
   *
   * Found via the user's second real `npm test` run (0.1.21 shipped
   * with 27/37 fixed, but 2 new ones surfaced once a real session
   * cookie actually reached a handler): `generates a usable set, and a
   * step-up login can consume one` got `res.body === undefined` even
   * though `/recovery-codes/generate`'s handler definitely ran. Root
   * cause was THIS function, not routes.js - real core middlewares
   * (session-middleware.js's own `sessionMiddleware`/`requireAuth`,
   * validation-middleware.js's `validateBody`) call `next()` as a bare
   * statement, Express-style, never `return next()`. The PREVIOUS
   * version of this function awaited the chain by awaiting each
   * handler's OWN return value - fine for a synchronous middleware
   * (its call to `next()` kicks off the rest of the chain and is
   * simply ignored/discarded, but the middleware itself returns
   * `undefined` immediately after, so `await handler(...)` resolves
   * right away) - but that means the awaited chain silently detaches
   * from the REAL remaining work the moment a bare `next()` call sits
   * in front of an async terminal handler that does genuine I/O.
   * `auth.generateRecoveryCodes()` hashes 8 codes with REAL argon2 -
   * genuine libuv thread-pool round trips, not just microtask hops -
   * so the detached "chain A" (the awaited next()-calls) resolved to
   * `return {req, res}` well before "chain B" (the real work) ever
   * called `res.json()`. Other async handlers in this file (the fake
   * `verifyPassword` stand-in, say) have no real internal await at
   * all, so chain A and chain B happened to finish in the same
   * microtask tick and the race never showed - pure luck, not
   * correctness.
   *
   * Fixed by not trusting the next()-chain's own promise for
   * completion at all: `res.json()`/`res.send()` now resolve a
   * dedicated `finished` promise (mirroring how a real HTTP response
   * actually signals "done" - Express doesn't await middleware
   * promises either, it watches the response), and dispatch() awaits
   * THAT instead of the chain. A thrown/rejected handler is caught at
   * whichever `next()` level invoked it and rejects the same
   * `finished` promise, so an error still fails the test loudly
   * instead of hanging forever.
   */
  async function dispatch(method, path, { body = {}, cookies = {}, query = {}, headers = {}, ip } = {}) {
    const route = routes.find((r) => r.method === method && r.regex.test(path));
    if (!route) throw new Error(`No route registered for ${method} ${path}`);
    const match = path.match(route.regex);
    const params = {};
    route.paramNames.forEach((name, i) => { params[name] = match[i + 1]; });

    const req = { body, cookies, query, params, headers, path, method: method.toUpperCase(), secure: true, ...(ip ? { ip } : {}) };

    let settled = false;
    let resolveFinished, rejectFinished;
    const finished = new Promise((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });
    function finish() {
      if (!settled) {
        settled = true;
        resolveFinished();
      }
    }

    const res = {
      statusCode: 200,
      body: undefined,
      cookies: {},
      cleared: [],
      headers: {},
      locals: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; finish(); return this; },
      send(payload) { this.body = payload; finish(); return this; },
      type() { return this; },
      redirect(code, url) { this.statusCode = code; this.headers.Location = url; finish(); return this; },
      cookie(name, value) { this.cookies[name] = value; },
      clearCookie(name) { this.cleared.push(name); },
    };

    const handlers = [...globalMiddlewares, ...route.handlers];
    let i = 0;
    const next = async () => {
      if (i >= handlers.length) {
        finish(); // chain exhausted without any handler responding - don't hang
        return;
      }
      const handler = handlers[i++];
      try {
        await handler(req, res, next);
      } catch (err) {
        if (!settled) {
          settled = true;
          rejectFinished(err);
        }
      }
    };
    next(); // intentionally not awaited - see the doc comment above
    await finished;
    return { req, res };
  }

  return { app, dispatch };
}

describe('workshop routes: Stage B (Users & Access)', () => {
  let db, fakeAuthProvider, dispatch, eventBus, fakeRunBackupJob, backupRunCalls, mails, bans;

  beforeEach(async () => {
    db = database.createSqliteAdapter({ file: ':memory:' });
    fakeAuthProvider = makeFakeAuthProvider(db);
    // Records every publish() call instead of discarding it, so Stage
    // E's Realtime Lab tests can assert a broadcast actually reached
    // the event bus - the same stand-in object other describe blocks
    // use, just no longer throwing the events away.
    const published = [];
    eventBus = { publish: (channel, event) => { published.push({ channel, event }); return 1; }, published };

    // Stage E (System & Maintenance): a fake backup job + an empty
    // destinations list - local:[] means GET /system/status's
    // listKnownBackups() always returns [], which is exactly what lets
    // the "verify an unknown file" negative test below prove the
    // known-backups allowlist actually rejects an arbitrary path,
    // without this test needing a real file on disk at all.
    backupRunCalls = 0;
    fakeRunBackupJob = async () => {
      backupRunCalls += 1;
      return [{ destinationId: 'local', backupPath: '/tmp/backup-test.db', prunedCount: 0 }];
    };

    // Stage C's `assets` table isn't created by any core module at
    // startup (unlike `users`, which core/auth's schema.js ensures
    // lazily) - it only exists after migrations/002_assets.js runs.
    // Calling its up(db) directly (same function the real migrator
    // calls, just without the schema_migrations bookkeeping this test
    // doesn't need) + seeding mirrors what `npm start`'s migrate-on-boot
    // (0.1.16, server.js) now does for real.
    upAssetsTable(db);
    seedAssetsIfEmpty(db);

    const harness = createFakeApp();
    dispatch = harness.dispatch;
    // The ONE middleware server.js mounts globally that this harness
    // actually needs to simulate - it's the only thing that ever sets
    // req.user (see the header comment above for the bug this fixes).
    harness.app.use(...fakeSessionMiddlewares(db));
    // Stands in for core/http's securityHeaders(), which sets the CSP
    // nonce on res.locals in the real app (server.js's createApp).
    harness.app.use((req, res, next) => {
      res.locals.cspNonce = 'test-nonce';
      next();
    });
    mails = [];
    const fakeEmailService = {
      enabled: true,
      sendPasswordReset: async (m) => void mails.push(['reset', m]),
      sendPasswordChanged: async (m) => void mails.push(['changed', m]),
    };
    bans = security.createBans(db);
    registerRoutes(harness.app, {
      bans,
      db,
      authProvider: fakeAuthProvider,
      eventBus,
      moduleRegistry: null,
      uploadsDir: '/tmp',
      appConfig: { backup: { destinations: [], retentionDays: 7 }, auth: { sessionTtlMs: 8 * 60 * 60 * 1000, passwordPolicy: { minLength: 8, maxLength: 128 } }, email: { baseUrl: 'https://app.example.com' } },
      migrationsDir: null, // migrationStatus() skipped when absent - see routes.js's GET /system/status
      runBackupJob: fakeRunBackupJob,
      emailService: fakeEmailService,
    });

    // Seed one operator and one admin user directly (bypassing
    // bootstrap.js, which this test doesn't need).
    const opHash = await fakeAuthProvider.hashPassword('op-password-1');
    auth.createUser(db, { username: 'alice', passwordHash: opHash, role: 'operator' });
    const adminHash = await fakeAuthProvider.hashPassword('admin-password-1');
    auth.createUser(db, { username: 'root', passwordHash: adminHash, role: 'admin' });
  });

  afterEach(() => db.close());

  async function loginAs(username, password, ip) {
    const { res } = await dispatch('post', '/login', { body: { username, password }, ip });
    return res;
  }

  function sessionCookieFrom(res) {
    return res.cookies.das_session;
  }

  describe('plain login (no MFA enrolled)', () => {
    it('issues a full session on correct credentials', async () => {
      const res = await loginAs('alice', 'op-password-1');
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ ok: true, mfaRequired: false, mustChangePassword: false });
      expect(sessionCookieFrom(res)).toBeTruthy();
    });

    it('rejects a wrong password without issuing a session', async () => {
      const res = await loginAs('alice', 'WRONG');
      expect(res.statusCode).toBe(401);
      expect(res.body.error).toBe('INVALID_CREDENTIALS');
      expect(sessionCookieFrom(res)).toBeUndefined();
    });

    it('rejects an unknown username with the SAME error as a wrong password', async () => {
      const res = await loginAs('nobody', 'whatever');
      expect(res.statusCode).toBe(401);
      expect(res.body.error).toBe('INVALID_CREDENTIALS');
    });

    it('rejects a disabled account with a distinct error, checked AFTER the password', async () => {
      // A disabled account whose password is otherwise still correct is
      // the case that actually proves the `disabled` check runs (an
      // anonymized user's password_hash is wiped too, which would mask
      // this - see auth.anonymizeUser()) - so disable the row directly.
      const user = auth.findUserByUsername(db, 'alice');
      db.run(`UPDATE users SET disabled = 1 WHERE id = ?`, [user.id]);

      const res = await loginAs('alice', 'op-password-1');
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe('ACCOUNT_DISABLED');
    });

    it('a session issued via /login grants access to /me and reflects role-based permissions', async () => {
      const loginRes = await loginAs('root', 'admin-password-1');
      const cookie = sessionCookieFrom(loginRes);
      const { res } = await dispatch('get', '/me', { cookies: { das_session: cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.body.username).toBe('root');
      expect(res.body.permissions).toContain('admin:write');
    });

    it('requireAuth rejects a request with no session cookie at all', async () => {
      const { res } = await dispatch('get', '/me', {});
      expect(res.statusCode).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    });
  });

  describe('TOTP step-up login (§8/§18)', () => {
    async function enrollTotpFor(username, password) {
      const loginRes = await loginAs(username, password);
      const cookie = sessionCookieFrom(loginRes);
      const start = await dispatch('post', '/totp/enroll/start', {
        cookies: { das_session: cookie },
        body: { name: 'authenticator-1' },
      });
      const secret = start.res.body.secret;
      const code = auth.generateTotp(secret);
      const verify = await dispatch('post', '/totp/enroll/verify', {
        cookies: { das_session: cookie },
        body: { authenticatorId: start.res.body.authenticatorId, code },
      });
      expect(verify.res.body).toEqual({ ok: true });
      return { secret, authenticatorId: start.res.body.authenticatorId };
    }

    it('after enrollment, a plain /login no longer issues a full session - it issues a pending one', async () => {
      await enrollTotpFor('alice', 'op-password-1');
      const res = await loginAs('alice', 'op-password-1');
      expect(res.body).toEqual({ ok: true, mfaRequired: true });

      // The pending session grants NOTHING on an ordinary route - this
      // is the core security property of the whole design.
      const { res: meRes } = await dispatch('get', '/me', { cookies: { das_session: sessionCookieFrom(res) } });
      expect(meRes.statusCode).toBe(401);
    });

    it('the correct TOTP code completes login and issues a real session', async () => {
      const { secret } = await enrollTotpFor('alice', 'op-password-1');
      const pendingRes = await loginAs('alice', 'op-password-1');
      const pendingCookie = sessionCookieFrom(pendingRes);

      const code = auth.generateTotp(secret);
      const { res } = await dispatch('post', '/login/totp', {
        cookies: { das_session: pendingCookie },
        body: { code },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      const fullCookie = sessionCookieFrom(res);
      expect(fullCookie).not.toBe(pendingCookie); // brand-new session id, not a promotion

      const { res: meRes } = await dispatch('get', '/me', { cookies: { das_session: fullCookie } });
      expect(meRes.statusCode).toBe(200);
      expect(meRes.body.username).toBe('alice');
    });

    it('a wrong TOTP code is rejected and does NOT burn the pending session (retry allowed)', async () => {
      await enrollTotpFor('alice', 'op-password-1');
      const pendingRes = await loginAs('alice', 'op-password-1');
      const pendingCookie = sessionCookieFrom(pendingRes);

      const wrong = await dispatch('post', '/login/totp', { cookies: { das_session: pendingCookie }, body: { code: '000000' } });
      expect(wrong.res.statusCode).toBe(401);
      expect(wrong.res.body.error).toBe('INVALID_CODE');

      // Pending session is still alive - a second, correct attempt works.
      const authenticators = auth.listAuthenticators(db, auth.findUserByUsername(db, 'alice').id);
      const secret = db.get(
        `SELECT secret FROM totp_credentials WHERE authenticator_id = ?`,
        [authenticators[0].id]
      ).secret;
      const code = auth.generateTotp(secret);
      const ok = await dispatch('post', '/login/totp', { cookies: { das_session: pendingCookie }, body: { code } });
      expect(ok.res.statusCode).toBe(200);
    });

    it('/login/totp refuses to run without a pending session', async () => {
      const { res } = await dispatch('post', '/login/totp', { body: { code: '123456' } });
      expect(res.statusCode).toBe(401);
      expect(res.body.error).toBe('NO_PENDING_LOGIN');
    });

    it('a FULL session cannot be reused to answer the TOTP step (no mfaPending flag)', async () => {
      const loginRes = await loginAs('root', 'admin-password-1'); // root has no TOTP enrolled - full session
      const { res } = await dispatch('post', '/login/totp', {
        cookies: { das_session: sessionCookieFrom(loginRes) },
        body: { code: '123456' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.body.error).toBe('NO_PENDING_LOGIN');
    });
  });

  describe('password change', () => {
    it('requires the correct current password, not just a valid session', async () => {
      const loginRes = await loginAs('alice', 'op-password-1');
      const cookie = sessionCookieFrom(loginRes);

      const bad = await dispatch('post', '/password/change', {
        cookies: { das_session: cookie },
        body: { currentPassword: 'WRONG', newPassword: 'brand-new-password' },
      });
      expect(bad.res.statusCode).toBe(401);
      expect(bad.res.body.error).toBe('WRONG_CURRENT_PASSWORD');

      const good = await dispatch('post', '/password/change', {
        cookies: { das_session: cookie },
        body: { currentPassword: 'op-password-1', newPassword: 'brand-new-password' },
      });
      expect(good.res.body).toEqual({ ok: true });

      // Old password no longer works, new one does.
      const oldLogin = await loginAs('alice', 'op-password-1');
      expect(oldLogin.statusCode).toBe(401);
      const newLogin = await loginAs('alice', 'brand-new-password');
      expect(newLogin.statusCode).toBe(200);
    });

    it('is blocked entirely without an authenticated session', async () => {
      const { res } = await dispatch('post', '/password/change', {
        body: { currentPassword: 'x', newPassword: 'brand-new-password' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('authenticator removal and the mfaRequired-for-admin policy', () => {
    it('an operator can remove their only factor freely (mfaRequired=false for their role)', async () => {
      const loginRes = await loginAs('alice', 'op-password-1');
      const cookie = sessionCookieFrom(loginRes);
      const start = await dispatch('post', '/totp/enroll/start', { cookies: { das_session: cookie }, body: {} });
      const code = auth.generateTotp(start.res.body.secret);
      await dispatch('post', '/totp/enroll/verify', {
        cookies: { das_session: cookie },
        body: { authenticatorId: start.res.body.authenticatorId, code },
      });

      const remove = await dispatch('post', `/totp/authenticators/${start.res.body.authenticatorId}/remove`, {
        cookies: { das_session: cookie },
      });
      expect(remove.res.body).toEqual({ ok: true });
    });

    it('an admin is blocked from removing their LAST factor (mfaRequired=true for their role)', async () => {
      const loginRes = await loginAs('root', 'admin-password-1');
      const cookie = sessionCookieFrom(loginRes);
      const start = await dispatch('post', '/totp/enroll/start', { cookies: { das_session: cookie }, body: {} });
      const code = auth.generateTotp(start.res.body.secret);
      await dispatch('post', '/totp/enroll/verify', {
        cookies: { das_session: cookie },
        body: { authenticatorId: start.res.body.authenticatorId, code },
      });

      const remove = await dispatch('post', `/totp/authenticators/${start.res.body.authenticatorId}/remove`, {
        cookies: { das_session: cookie },
      });
      expect(remove.res.statusCode).toBe(409);
      expect(remove.res.body.error).toBe('LAST_REQUIRED_FACTOR');
    });
  });

  describe('role restriction enforced on the server, not just hidden in the UI', () => {
    it('the existing field-permission scenario (finance cost) still holds with no moduleRegistry', async () => {
      // moduleRegistry is null in this test harness - fieldPermissions
      // falls back to {} - this is the pre-existing /assets behavior,
      // unaffected by Stage B, re-asserted here as a regression guard.
      const loginRes = await loginAs('alice', 'op-password-1');
      const { res } = await dispatch('get', '/assets', { cookies: { das_session: sessionCookieFrom(loginRes) } });
      expect(res.statusCode).toBe(200);
      expect(res.body[0]).toHaveProperty('cost'); // no fieldPermissions registered -> nothing is stripped
    });
  });

  describe('recovery codes (§22)', () => {
    it('generates a usable set, and a step-up login can consume one', async () => {
      const loginRes = await loginAs('alice', 'op-password-1');
      const cookie = sessionCookieFrom(loginRes);
      const start = await dispatch('post', '/totp/enroll/start', { cookies: { das_session: cookie }, body: {} });
      const code = auth.generateTotp(start.res.body.secret);
      await dispatch('post', '/totp/enroll/verify', {
        cookies: { das_session: cookie },
        body: { authenticatorId: start.res.body.authenticatorId, code },
      });

      const gen = await dispatch('post', '/recovery-codes/generate', { cookies: { das_session: cookie }, body: {} });
      expect(gen.res.body.codes).toHaveLength(8);

      const pendingRes = await loginAs('alice', 'op-password-1'); // now MFA-gated
      const recovery = await dispatch('post', '/login/recovery', {
        cookies: { das_session: sessionCookieFrom(pendingRes) },
        body: { code: gen.res.body.codes[0] },
      });
      expect(recovery.res.statusCode).toBe(200);

      const remaining = await dispatch('get', '/recovery-codes/remaining', { cookies: { das_session: sessionCookieFrom(recovery.res) } });
      expect(remaining.res.body.remaining).toBe(7); // one consumed
    });

    it('rejects a bogus recovery code without issuing a session', async () => {
      const loginRes = await loginAs('alice', 'op-password-1');
      const cookie = sessionCookieFrom(loginRes);
      const start = await dispatch('post', '/totp/enroll/start', { cookies: { das_session: cookie }, body: {} });
      const totpCode = auth.generateTotp(start.res.body.secret);
      await dispatch('post', '/totp/enroll/verify', {
        cookies: { das_session: cookie },
        body: { authenticatorId: start.res.body.authenticatorId, code: totpCode },
      });
      await dispatch('post', '/recovery-codes/generate', { cookies: { das_session: cookie }, body: {} });

      const pendingRes = await loginAs('alice', 'op-password-1');
      const { res } = await dispatch('post', '/login/recovery', {
        cookies: { das_session: sessionCookieFrom(pendingRes) },
        body: { code: 'WRONG-CODE' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.body.error).toBe('INVALID_CODE');
    });
  });

  describe('TOTP enrollment negative cases', () => {
    it('rejects a wrong verification code and leaves the authenticator unusable for login', async () => {
      const loginRes = await loginAs('alice', 'op-password-1');
      const cookie = sessionCookieFrom(loginRes);
      const start = await dispatch('post', '/totp/enroll/start', { cookies: { das_session: cookie }, body: {} });

      const bad = await dispatch('post', '/totp/enroll/verify', {
        cookies: { das_session: cookie },
        body: { authenticatorId: start.res.body.authenticatorId, code: '000000' },
      });
      expect(bad.res.statusCode).toBe(400);
      expect(bad.res.body.error).toBe('INVALID_CODE');

      // Still unenrolled - next login is a plain full session, not MFA-gated.
      const relogin = await loginAs('alice', 'op-password-1');
      expect(relogin.body.mfaRequired).toBe(false);
    });
  });

  describe('Demo Records (Stage C) - unauthenticated and not-found', () => {
    it('every /assets* route rejects a request with no session', async () => {
      const paths = [
        ['get', '/assets'],
        ['get', '/assets/1'],
        ['post', '/assets'],
        ['patch', '/assets/1'],
        ['delete', '/assets/1'],
        ['post', '/assets/1/cost'],
      ];
      for (const [method, path] of paths) {
        const { res } = await dispatch(method, path, {});
        expect(res.statusCode).toBe(401);
        expect(res.body.error).toBe('UNAUTHENTICATED');
      }
    });

    it('404s on an unknown id for get/update/delete/cost, not a 500 or a silent no-op', async () => {
      const loginRes = await loginAs('root', 'admin-password-1');
      const cookie = { das_session: sessionCookieFrom(loginRes) };

      const get = await dispatch('get', '/assets/999999', { cookies: cookie });
      expect(get.res.statusCode).toBe(404);
      expect(get.res.body.error).toBe('NOT_FOUND');

      const patch = await dispatch('patch', '/assets/999999', { cookies: cookie, body: { name: 'x', org: 'y' } });
      expect(patch.res.statusCode).toBe(404);

      const del = await dispatch('delete', '/assets/999999', { cookies: cookie });
      expect(del.res.statusCode).toBe(404);

      const cost = await dispatch('post', '/assets/999999/cost', { cookies: cookie, body: { cost: 10 } });
      expect(cost.res.statusCode).toBe(404);
    });

    it('rejects a create with no name/org with a validation error, not a half-written row', async () => {
      const loginRes = await loginAs('alice', 'op-password-1');
      const { res } = await dispatch('post', '/assets', {
        cookies: { das_session: sessionCookieFrom(loginRes) },
        body: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('create ignores a smuggled "cost" field in the body entirely (schema excludes it, see CreateAssetSchema)', async () => {
      const loginRes = await loginAs('root', 'admin-password-1');
      const { res } = await dispatch('post', '/assets', {
        cookies: { das_session: sessionCookieFrom(loginRes) },
        body: { name: 'Sneaky Laptop', org: 'IT', cost: 99999 },
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.cost).toBeNull(); // never set via create, regardless of who's asking
    });

    it('delete is admin-only: operator gets 403, admin gets 200 and the row is actually gone', async () => {
      const opLogin = await loginAs('alice', 'op-password-1');
      const forbidden = await dispatch('delete', '/assets/1', { cookies: { das_session: sessionCookieFrom(opLogin) } });
      expect(forbidden.res.statusCode).toBe(403);
      expect(forbidden.res.body.error).toBe('FORBIDDEN');

      const stillThere = await dispatch('get', '/assets/1', { cookies: { das_session: sessionCookieFrom(opLogin) } });
      expect(stillThere.res.statusCode).toBe(200);

      const adminLogin = await loginAs('root', 'admin-password-1');
      const deleted = await dispatch('delete', '/assets/1', { cookies: { das_session: sessionCookieFrom(adminLogin) } });
      expect(deleted.res.statusCode).toBe(200);

      const gone = await dispatch('get', '/assets/1', { cookies: { das_session: sessionCookieFrom(adminLogin) } });
      expect(gone.res.statusCode).toBe(404);
    });
  });

  describe('Demo Records (Stage C) - finance-gated cost, with a REAL moduleRegistry', () => {
    // Separate harness from the describe blocks above: this one
    // registers reporting-module.js for real (fieldPermissions:
    // {cost: 'read:finance'}), instead of the `moduleRegistry: null`
    // used everywhere else in this file - that null case is its own
    // deliberately-asserted regression (see "the existing
    // field-permission scenario" test above), not an oversight.
    let localDb, localDispatch;

    beforeEach(async () => {
      localDb = database.createSqliteAdapter({ file: ':memory:' });
      upAssetsTable(localDb);
      seedAssetsIfEmpty(localDb);
      const localAuthProvider = makeFakeAuthProvider(localDb);

      const registry = modules.createModuleRegistry();
      registry.registerModule(
        createReportingModule({ db: localDb, findUserByIdFn: auth.findUserById, auditQueryFn: () => [] })
      );

      const harness = createFakeApp();
      localDispatch = harness.dispatch;
      harness.app.use(...fakeSessionMiddlewares(localDb));
      registerRoutes(harness.app, {
        db: localDb,
        authProvider: localAuthProvider,
        eventBus: { publish() {} },
        moduleRegistry: registry,
        uploadsDir: '/tmp',
      });

      const opHash = await localAuthProvider.hashPassword('op-password-1');
      auth.createUser(localDb, { username: 'alice', passwordHash: opHash, role: 'operator' });
      const adminHash = await localAuthProvider.hashPassword('admin-password-1');
      auth.createUser(localDb, { username: 'root', passwordHash: adminHash, role: 'admin' });
    });

    afterEach(() => localDb.close());

    async function localLoginAs(username, password) {
      const { res } = await localDispatch('post', '/login', { body: { username, password } });
      return res;
    }

    it('/ui HTML-escapes the username it greets (A14) - a markup-looking username cannot inject elements', async () => {
      const hash = await makeFakeAuthProvider(localDb).hashPassword('xss-password-1');
      const evil = '<img src=x onerror=alert(1)>';
      auth.createUser(localDb, { username: evil, passwordHash: hash, role: 'operator' });
      const loginRes = await localLoginAs(evil, 'xss-password-1');
      expect(loginRes.statusCode).toBe(200);
      const { res } = await localDispatch('get', '/ui', { cookies: { das_session: sessionCookieFrom(loginRes) } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(res.body).not.toContain('<img src=x');
    });

    it('the user name in the page header leads to the account settings (and the brand, when shown, leads home)', async () => {
      const loginRes = await localLoginAs('alice', 'op-password-1');
      const { res } = await localDispatch('get', '/ui', { cookies: { das_session: sessionCookieFrom(loginRes) } });
      expect(res.body).toContain('<a class="adm-user" href="/ui/account">alice</a>');
      if (res.body.includes('<div class="adm-brand">')) expect(res.body).toContain('<a class="adm-brand-link" href="/ui">');
    });

    it('an operator (no read:finance) never sees the cost field at all - stripped server-side, not just hidden in a client', async () => {
      const loginRes = await localLoginAs('alice', 'op-password-1');
      const { res } = await localDispatch('get', '/assets', { cookies: { das_session: sessionCookieFrom(loginRes) } });
      expect(res.statusCode).toBe(200);
      expect(res.body[0]).not.toHaveProperty('cost');
    });

    it('an operator cannot set cost - 403, not a silently-ignored write', async () => {
      const loginRes = await localLoginAs('alice', 'op-password-1');
      const { res } = await localDispatch('post', '/assets/1/cost', {
        cookies: { das_session: sessionCookieFrom(loginRes) },
        body: { cost: 1234 },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('an admin (has read:finance) can set and then see cost', async () => {
      const loginRes = await localLoginAs('root', 'admin-password-1');
      const cookie = { das_session: sessionCookieFrom(loginRes) };

      const setRes = await localDispatch('post', '/assets/1/cost', { cookies: cookie, body: { cost: 1500 } });
      expect(setRes.res.statusCode).toBe(200);
      expect(setRes.res.body.cost).toBe(1500);

      const getRes = await localDispatch('get', '/assets/1', { cookies: cookie });
      expect(getRes.res.body.cost).toBe(1500);
    });

    it('rejects a negative cost as a validation error', async () => {
      const loginRes = await localLoginAs('root', 'admin-password-1');
      const { res } = await localDispatch('post', '/assets/1/cost', {
        cookies: { das_session: sessionCookieFrom(loginRes) },
        body: { cost: -5 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('Audit & Activity (Stage D)', () => {
    it('GET /audit rejects an unauthenticated request', async () => {
      const { res } = await dispatch('get', '/audit', {});
      expect(res.statusCode).toBe(401);
    });

    it('GET /audit rejects a non-admin with 403, not a filtered/empty response', async () => {
      const loginRes = await loginAs('alice', 'op-password-1');
      const { res } = await dispatch('get', '/audit', { cookies: { das_session: sessionCookieFrom(loginRes) } });
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('a successful login is actually recorded and visible to an admin via GET /audit', async () => {
      await loginAs('alice', 'op-password-1'); // generates one auth.login entry

      const adminLogin = await loginAs('root', 'admin-password-1'); // generates a second
      const { res } = await dispatch('get', '/audit', { cookies: { das_session: sessionCookieFrom(adminLogin) } });
      expect(res.statusCode).toBe(200);
      expect(res.body.total).toBeGreaterThanOrEqual(2);
      const aliceEntry = res.body.entries.find((e) => e.actor === 'alice' && e.action === 'auth.login');
      expect(aliceEntry).toBeTruthy();
      expect(aliceEntry.result).toBe('success');
    });

    it('a failed login attempt is recorded as a failure, with the attempted username as actor', async () => {
      await loginAs('alice', 'WRONG-PASSWORD');

      const adminLogin = await loginAs('root', 'admin-password-1');
      const { res } = await dispatch('get', '/audit', {
        cookies: { das_session: sessionCookieFrom(adminLogin) },
        query: { actor: 'alice', result: 'failure' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.entries.length).toBeGreaterThanOrEqual(1);
      expect(res.body.entries.every((e) => e.result === 'failure')).toBe(true);
      expect(res.body.entries.every((e) => e.actor === 'alice')).toBe(true);
    });

    it('an unknown username still gets recorded, as a failure, with the attempted (non-existent) username', async () => {
      await loginAs('totally-bogus-user', 'whatever');

      const adminLogin = await loginAs('root', 'admin-password-1');
      const { res } = await dispatch('get', '/audit', {
        cookies: { das_session: sessionCookieFrom(adminLogin) },
        query: { actor: 'totally-bogus-user' },
      });
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].result).toBe('failure');
    });

    it('a write on another resource (asset create) is recorded too, not just auth events', async () => {
      const loginRes = await loginAs('alice', 'op-password-1');
      const cookie = { das_session: sessionCookieFrom(loginRes) };
      const created = await dispatch('post', '/assets', { cookies: cookie, body: { name: 'Audit Test Asset', org: 'QA' } });
      expect(created.res.statusCode).toBe(201);

      const adminLogin = await loginAs('root', 'admin-password-1');
      const { res } = await dispatch('get', '/audit', {
        cookies: { das_session: sessionCookieFrom(adminLogin) },
        query: { action: 'asset.create' },
      });
      // audit_log's entity_id column is TEXT (core/audit supports both
      // numeric and UUID-style entity ids, see query.js's doc comment),
      // so core/audit's mapper.js always returns entityId as a STRING
      // - by design, not a bug. The asset's own id is a real DB
      // integer, so the comparison needs an explicit String() on one
      // side rather than relying on `===` to coerce it.
      const entry = res.body.entries.find((e) => e.entityId === String(created.res.body.id));
      expect(entry).toBeTruthy();
      expect(entry.actor).toBe('alice');
    });

    it('the action filter narrows results - "auth.login" does not also return "auth.login.pending" entries', async () => {
      const adminLogin = await loginAs('root', 'admin-password-1');
      const { res } = await dispatch('get', '/audit', {
        cookies: { das_session: sessionCookieFrom(adminLogin) },
        query: { action: 'auth.login' },
      });
      expect(res.body.entries.every((e) => e.action === 'auth.login')).toBe(true);
    });
  });

  describe('System & Maintenance (Stage E)', () => {
    it('GET /system/status rejects an unauthenticated request', async () => {
      const { res } = await dispatch('get', '/system/status', {});
      expect(res.statusCode).toBe(401);
    });

    it('GET /system/status rejects a non-admin with 403', async () => {
      const loginRes = await loginAs('alice', 'op-password-1');
      const { res } = await dispatch('get', '/system/status', { cookies: { das_session: sessionCookieFrom(loginRes) } });
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('an admin sees health/migrations/backups bundled in one response', async () => {
      const loginRes = await loginAs('root', 'admin-password-1');
      const { res } = await dispatch('get', '/system/status', { cookies: { das_session: sessionCookieFrom(loginRes) } });
      expect(res.statusCode).toBe(200);
      expect(res.body.health.status).toBe('ok');
      expect(res.body.backups).toEqual([]); // no destinations configured in this test harness
      expect(res.body.migrations).toEqual([]); // migrationsDir: null in this test harness
      expect(res.body.retentionDays).toBe(7);
    });

    it('POST /system/backup/run rejects a non-admin with 403 and never calls the backup job', async () => {
      const loginRes = await loginAs('alice', 'op-password-1');
      const { res } = await dispatch('post', '/system/backup/run', { cookies: { das_session: sessionCookieFrom(loginRes) } });
      expect(res.statusCode).toBe(403);
      expect(backupRunCalls).toBe(0);
    });

    it('POST /system/backup/run as admin actually invokes the backup job and reports its results', async () => {
      const loginRes = await loginAs('root', 'admin-password-1');
      const { res } = await dispatch('post', '/system/backup/run', { cookies: { das_session: sessionCookieFrom(loginRes) } });
      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.results).toHaveLength(1);
      expect(backupRunCalls).toBe(1);

      // and it shows up in the audit trail, same as every other
      // write route (Stage D) - System & Maintenance is not exempt.
      const { res: auditRes } = await dispatch('get', '/audit', {
        cookies: { das_session: sessionCookieFrom(loginRes) },
        query: { action: 'system.backup_run' },
      });
      expect(auditRes.body.entries).toHaveLength(1);
      expect(auditRes.body.entries[0].result).toBe('success');
    });

    it('POST /system/backup/verify rejects a path that is not in the known-backups list (404, not an arbitrary file open)', async () => {
      const loginRes = await loginAs('root', 'admin-password-1');
      const { res } = await dispatch('post', '/system/backup/verify', {
        cookies: { das_session: sessionCookieFrom(loginRes) },
        body: { file: '/etc/passwd' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body.ok).toBe(false);
    });

    it('POST /system/backup/verify rejects an empty file with a validation error, not a crash', async () => {
      const loginRes = await loginAs('root', 'admin-password-1');
      const { res } = await dispatch('post', '/system/backup/verify', {
        cookies: { das_session: sessionCookieFrom(loginRes) },
        body: { file: '' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('Realtime Lab (Stage E)', () => {
    it('POST /events/lab/broadcast rejects an unauthenticated request', async () => {
      const { res } = await dispatch('post', '/events/lab/broadcast', { body: { message: 'hi' } });
      expect(res.statusCode).toBe(401);
    });

    it('rejects an empty message as a validation error', async () => {
      const loginRes = await loginAs('alice', 'op-password-1');
      const { res } = await dispatch('post', '/events/lab/broadcast', {
        cookies: { das_session: sessionCookieFrom(loginRes) },
        body: { message: '' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('rejects a message over 500 characters', async () => {
      const loginRes = await loginAs('alice', 'op-password-1');
      const { res } = await dispatch('post', '/events/lab/broadcast', {
        cookies: { das_session: sessionCookieFrom(loginRes) },
        body: { message: 'x'.repeat(501) },
      });
      expect(res.statusCode).toBe(400);
    });

    it('any authenticated user (not just admin) can broadcast - this is a shared playground, not an admin surface', async () => {
      const loginRes = await loginAs('alice', 'op-password-1');
      const { res } = await dispatch('post', '/events/lab/broadcast', {
        cookies: { das_session: sessionCookieFrom(loginRes) },
        body: { message: 'hello from alice' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);

      // and it actually reached the event bus, on the 'lab' channel,
      // carrying a pseudonym built from the authenticated user's id (never
      // client-supplied, and no login name reaches other users, F10).
      const published = eventBus.published.find((p) => p.channel === 'lab');
      expect(published).toBeTruthy();
      const aliceId = auth.findUserByUsername(db, 'alice').id;
      expect(published.event).toMatchObject({ type: 'lab-message', from: `user #${aliceId}`, message: 'hello from alice' });
    });
  });

  describe('Hardening (audit wave 1)', () => {
    // 1x1 transparent PNG - only its signature matters to validateUpload's type sniffing
    async function enrollTotpFor(username, password) {
      const loginRes = await loginAs(username, password);
      const cookie = sessionCookieFrom(loginRes);
      const start = await dispatch('post', '/totp/enroll/start', { cookies: { das_session: cookie }, body: { name: 'a1' } });
      await dispatch('post', '/totp/enroll/verify', {
        cookies: { das_session: cookie },
        body: { authenticatorId: start.res.body.authenticatorId, code: auth.generateTotp(start.res.body.secret) },
      });
      return { secret: start.res.body.secret };
    }

    describe('brute-force protection on /login (A02)', () => {
      it('locks a username after 5 wrong passwords - even the CORRECT password then gets 429', async () => {
        for (let i = 0; i < 5; i++) {
          const res = await loginAs('alice', `wrong-${i}`);
          expect(res.statusCode).toBe(401);
        }
        const locked = await loginAs('alice', 'op-password-1');
        expect(locked.statusCode).toBe(429);
        expect(locked.body.error).toBe('TOO_MANY_ATTEMPTS');
        expect(locked.body.retryAfterSec).toBeGreaterThanOrEqual(1);
        expect(locked.headers['Retry-After']).toBeTruthy();
        expect(sessionCookieFrom(locked)).toBeUndefined();
      });

      it('a stranger cannot lock the real user out: the lockout is per (name, address) (K03)', async () => {
        for (let i = 0; i < 5; i++) expect((await loginAs('alice', `bad-${i}`, '198.51.100.9')).statusCode).toBe(401);
        expect((await loginAs('alice', 'op-password-1', '198.51.100.9')).statusCode).toBe(429);
        // the owner, from another address, signs in normally
        expect((await loginAs('alice', 'op-password-1', '203.0.113.5')).statusCode).toBe(200);
      });

      it('a banned username is refused at sign-in and gets no session (audit of the bans)', async () => {
      bans.ban({ kind: 'user', value: 'alice', by: 'root' });
      const res = await loginAs('alice', 'op-password-1');
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe('BANNED');
      expect(sessionCookieFrom(res)).toBeUndefined();
      bans.lift({ kind: 'user', value: 'alice', by: 'root' });
      expect((await loginAs('alice', 'op-password-1')).statusCode).toBe(200);
    });

    it('an UNKNOWN username locks identically - the lockout is not an enumeration oracle', async () => {
        for (let i = 0; i < 5; i++) await loginAs('ghost', `x${i}`);
        const locked = await loginAs('ghost', 'x');
        expect(locked.statusCode).toBe(429);
        expect(locked.body.error).toBe('TOO_MANY_ATTEMPTS');
      });

      it('username matching is case-insensitive for the lockout (Alice/ALICE share one budget)', async () => {
        for (let i = 0; i < 5; i++) await loginAs(i % 2 ? 'ALICE' : 'Alice', `x${i}`);
        const locked = await loginAs('alice', 'op-password-1');
        expect(locked.statusCode).toBe(429);
      });

      it('a successful login forgets earlier misses for that username', async () => {
        for (let i = 0; i < 4; i++) await loginAs('alice', `x${i}`);
        expect((await loginAs('alice', 'op-password-1')).statusCode).toBe(200);
        // budget is fresh again: 4 more misses still do not lock
        for (let i = 0; i < 4; i++) await loginAs('alice', `y${i}`);
        expect((await loginAs('alice', 'op-password-1')).statusCode).toBe(200);
      });

      it("one user's lockout does not affect another user", async () => {
        for (let i = 0; i < 5; i++) await loginAs('alice', `x${i}`);
        expect((await loginAs('root', 'admin-password-1')).statusCode).toBe(200);
      });

      it('records a locked_out audit entry', async () => {
        for (let i = 0; i < 5; i++) await loginAs('alice', `x${i}`);
        await loginAs('alice', 'op-password-1');
        const entries = audit.query(db, { action: 'auth.login', result: 'failure', limit: 50 });
        expect(entries.some((e) => e.meta?.reason === 'locked_out')).toBe(true);
      });

      it('the per-IP request limiter answers 429 RATE_LIMITED once the window budget is spent', async () => {
        let last;
        for (let i = 0; i < 11; i++) last = await loginAs(`user-${i}`, 'x'); // distinct names: no username lockout involved
        expect(last.statusCode).toBe(429);
        expect(last.body.error).toBe('RATE_LIMITED');
      });

      it('unknown usernames still pay for a password verification (timing parity, A09)', async () => {
        let calls = 0;
        const original = fakeAuthProvider.verifyPassword;
        fakeAuthProvider.verifyPassword = async (...args) => {
          calls += 1;
          return original(...args);
        };
        await loginAs('ghost', 'whatever');
        expect(calls).toBe(1);
        await loginAs('alice', 'WRONG');
        expect(calls).toBe(2);
      });
    });

    describe('brute-force protection on the MFA step (A02)', () => {
      it('burns the pending session after 5 wrong TOTP codes and keeps the user locked across re-logins', async () => {
        const { secret } = await enrollTotpFor('alice', 'op-password-1');
        const pending = sessionCookieFrom(await loginAs('alice', 'op-password-1'));

        let last;
        for (let i = 0; i < 5; i++) {
          last = await dispatch('post', '/login/totp', { cookies: { das_session: pending }, body: { code: '000000' } });
        }
        expect(last.res.statusCode).toBe(429);
        expect(last.res.body.error).toBe('TOO_MANY_ATTEMPTS');

        // the pending session is gone: even the right code no longer works with it
        const withDead = await dispatch('post', '/login/totp', { cookies: { das_session: pending }, body: { code: auth.generateTotp(secret) } });
        expect(withDead.res.statusCode).toBe(401);
        expect(withDead.res.body.error).toBe('NO_PENDING_LOGIN');

        // ...and re-doing the password step mints a fresh pending session, but the lock outlives it
        const pending2 = sessionCookieFrom(await loginAs('alice', 'op-password-1'));
        const retry = await dispatch('post', '/login/totp', { cookies: { das_session: pending2 }, body: { code: auth.generateTotp(secret) } });
        expect(retry.res.statusCode).toBe(429);
      });

      it('recovery-code guesses share the same budget as TOTP guesses', async () => {
        await enrollTotpFor('alice', 'op-password-1');
        const pending = sessionCookieFrom(await loginAs('alice', 'op-password-1'));
        let last;
        for (let i = 0; i < 5; i++) {
          last = await dispatch('post', '/login/recovery', { cookies: { das_session: pending }, body: { code: 'AAAA-BBBB' } });
        }
        expect(last.res.statusCode).toBe(429);
      });

      it('4 misses then a correct code still succeeds and clears the budget', async () => {
        const { secret } = await enrollTotpFor('alice', 'op-password-1');
        const pending = sessionCookieFrom(await loginAs('alice', 'op-password-1'));
        for (let i = 0; i < 4; i++) {
          const r = await dispatch('post', '/login/totp', { cookies: { das_session: pending }, body: { code: '000000' } });
          expect(r.res.statusCode).toBe(401);
        }
        const ok = await dispatch('post', '/login/totp', { cookies: { das_session: pending }, body: { code: auth.generateTotp(secret) } });
        expect(ok.res.statusCode).toBe(200);
      });
    });

    describe('forced password change (A06)', () => {
      async function loginTempUser() {
        const hash = await fakeAuthProvider.hashPassword('temp-password-1');
        auth.createUser(db, { username: 'newhire', passwordHash: hash, role: 'operator', mustChangePassword: true });
        const res = await loginAs('newhire', 'temp-password-1');
        expect(res.body.mustChangePassword).toBe(true);
        return sessionCookieFrom(res);
      }

      it('a temporary password reaches NOTHING but the password-change flow', async () => {
        const cookie = await loginTempUser();
        const blocked = await dispatch('get', '/assets', { cookies: { das_session: cookie } });
        expect(blocked.res.statusCode).toBe(403);
        expect(blocked.res.body.error).toBe('PASSWORD_CHANGE_REQUIRED');

        const events = await dispatch('post', '/events/lab/broadcast', { cookies: { das_session: cookie }, body: { message: 'hi' } });
        expect(events.res.statusCode).toBe(403);

        // a browser is taken to the password-change page instead of seeing raw JSON
        const page = await dispatch('get', '/assets', { cookies: { das_session: cookie }, headers: { accept: 'text/html,application/xhtml+xml' } });
        expect(page.res.statusCode).toBe(302);
        expect(page.res.headers.Location).toBe('/ui/password');

        const me = await dispatch('get', '/me', { cookies: { das_session: cookie } });
        expect(me.res.statusCode).toBe(200);
      });

      it('changing the password lifts the block and swaps in a fresh session; the old cookie dies', async () => {
        const oldCookie = await loginTempUser();
        const change = await dispatch('post', '/password/change', {
          cookies: { das_session: oldCookie },
          body: { currentPassword: 'temp-password-1', newPassword: 'brand-new-password-1' },
        });
        expect(change.res.statusCode).toBe(200);
        const newCookie = sessionCookieFrom(change.res);
        expect(newCookie).toBeTruthy();
        expect(newCookie).not.toBe(oldCookie);

        const ok = await dispatch('get', '/assets', { cookies: { das_session: newCookie } });
        expect(ok.res.statusCode).toBe(200);
        const old = await dispatch('get', '/me', { cookies: { das_session: oldCookie } });
        expect(old.res.statusCode).toBe(401);
      });

      it('with a temporary password the new password is enough - no current password is asked', async () => {
        const cookie = await loginTempUser();
        const same = await dispatch('post', '/password/change', { cookies: { das_session: cookie }, body: { newPassword: 'temp-password-1' } });
        expect(same.res.statusCode).toBe(400);
        const change = await dispatch('post', '/password/change', { cookies: { das_session: cookie }, body: { newPassword: 'brand-new-password-2' } });
        expect(change.res.statusCode).toBe(200);
        const fresh = sessionCookieFrom(change.res);
        expect((await dispatch('get', '/assets', { cookies: { das_session: fresh } })).res.statusCode).toBe(200);
      });

      it('a normal user must still give the current password', async () => {
        const cookie = sessionCookieFrom(await loginAs('alice', 'op-password-1'));
        const res = await dispatch('post', '/password/change', { cookies: { das_session: cookie }, body: { newPassword: 'whatever-password-9' } });
        expect(res.res.statusCode).toBe(400);
      });

      it('a normal user (no forced change) is never blocked', async () => {
        const cookie = sessionCookieFrom(await loginAs('alice', 'op-password-1'));
        const res = await dispatch('get', '/assets', { cookies: { das_session: cookie } });
        expect(res.res.statusCode).toBe(200);
      });
    });

    describe('session revocation on password change (A05)', () => {
      it('every OTHER session of the user dies, and the caller is re-issued a working one', async () => {
        const laptop = sessionCookieFrom(await loginAs('alice', 'op-password-1'));
        const phone = sessionCookieFrom(await loginAs('alice', 'op-password-1'));
        const change = await dispatch('post', '/password/change', {
          cookies: { das_session: laptop },
          body: { currentPassword: 'op-password-1', newPassword: 'another-password-1' },
        });
        expect(change.res.statusCode).toBe(200);

        expect((await dispatch('get', '/me', { cookies: { das_session: phone } })).res.statusCode).toBe(401);
        expect((await dispatch('get', '/me', { cookies: { das_session: laptop } })).res.statusCode).toBe(401);
        const fresh = sessionCookieFrom(change.res);
        expect((await dispatch('get', '/me', { cookies: { das_session: fresh } })).res.statusCode).toBe(200);
      });

      it("another user's sessions are untouched", async () => {
        const rootCookie = sessionCookieFrom(await loginAs('root', 'admin-password-1'));
        const aliceCookie = sessionCookieFrom(await loginAs('alice', 'op-password-1'));
        await dispatch('post', '/password/change', {
          cookies: { das_session: aliceCookie },
          body: { currentPassword: 'op-password-1', newPassword: 'another-password-1' },
        });
        expect((await dispatch('get', '/me', { cookies: { das_session: rootCookie } })).res.statusCode).toBe(200);
      });
    });

    describe('login drops the previous session (A13)', () => {
      it('a session cookie sent with the login request is destroyed, the new one differs', async () => {
        const first = sessionCookieFrom(await loginAs('alice', 'op-password-1'));
        const { res } = await dispatch('post', '/login', {
          cookies: { das_session: first },
          body: { username: 'alice', password: 'op-password-1' },
        });
        expect(res.statusCode).toBe(200);
        const second = sessionCookieFrom(res);
        expect(second).not.toBe(first);
        expect((await dispatch('get', '/me', { cookies: { das_session: first } })).res.statusCode).toBe(401);
        expect((await dispatch('get', '/me', { cookies: { das_session: second } })).res.statusCode).toBe(200);
      });

      it('a megabyte password is rejected by validation before it can reach argon2', async () => {
        const { res } = await dispatch('post', '/login', { body: { username: 'alice', password: 'x'.repeat(5000) } });
        expect(res.statusCode).toBe(400);
      });
    });

    describe('password policy on change (A15)', () => {
      async function change(newPassword, currentPassword = 'op-password-1') {
        const cookie = sessionCookieFrom(await loginAs('alice', 'op-password-1'));
        return (await dispatch('post', '/password/change', { cookies: { das_session: cookie }, body: { currentPassword, newPassword } })).res;
      }

      it('too short, too long, common, equal to username, equal to current are refused with codes', async () => {
        expect((await change('short')).body).toMatchObject({ error: 'WEAK_PASSWORD', problems: ['TOO_SHORT'] });
        expect((await change('a'.repeat(129))).body.problems).toContain('TOO_LONG');
        expect((await change('password123')).body.problems).toContain('COMMON');
        expect((await change('op-password-1')).body.problems).toContain('SAME_AS_CURRENT');
      });

      it('a refused change leaves the password and the sessions alone', async () => {
        const cookie = sessionCookieFrom(await loginAs('alice', 'op-password-1'));
        const r = await dispatch('post', '/password/change', { cookies: { das_session: cookie }, body: { currentPassword: 'op-password-1', newPassword: 'short' } });
        expect(r.res.statusCode).toBe(400);
        expect((await dispatch('get', '/me', { cookies: { das_session: cookie } })).res.statusCode).toBe(200);
        expect((await loginAs('alice', 'op-password-1')).statusCode).toBe(200);
      });
    });

    describe('forgotten password by e-mail', () => {
      const flush = () => new Promise((r) => setTimeout(r, 30));
      const tokenFromMail = () => new URL(mails.find(([k]) => k === 'reset')[1].resetUrl).hash.slice('#token='.length);
      beforeEach(() => db.run(`UPDATE users SET email = 'alice@example.com' WHERE username = 'alice'`));

      it('answers 202 identically for a real login, an e-mail, an unknown login and a user without an address', async () => {
        const answers = [];
        for (const login of ['alice', 'ALICE@example.com', 'nobody', 'root']) {
          const { res } = await dispatch('post', '/password/forgot', { body: { login } });
          answers.push([res.statusCode, JSON.stringify(res.body)]);
        }
        expect(new Set(answers.map((a) => a.join('|'))).size).toBe(1);
        expect(answers[0][0]).toBe(202);
        await flush();
        expect(mails).toHaveLength(2); // alice by name, alice by address; nobody and root (no address) got nothing
      });

      it('the mail carries an https link with the token in the fragment', async () => {
        await dispatch('post', '/password/forgot', { body: { login: 'alice' } });
        await flush();
        const [, mail] = mails[0];
        expect(mail.to).toBe('alice@example.com');
        expect(mail.resetUrl).toMatch(/^https:\/\/app\.example\.com\/reset-password#token=[A-Za-z0-9_-]{40,}$/);
        expect(mail.expiresInMinutes).toBe(30);
      });

      it('a disabled account gets no mail', async () => {
        db.run(`UPDATE users SET disabled = 1 WHERE username = 'alice'`);
        await dispatch('post', '/password/forgot', { body: { login: 'alice' } });
        await flush();
        expect(mails).toHaveLength(0);
      });

      it('the token sets a new password once, signs the user out everywhere and sends a notice', async () => {
        const cookie = sessionCookieFrom(await loginAs('alice', 'op-password-1'));
        await dispatch('post', '/password/forgot', { body: { login: 'alice' } });
        await flush();
        const token = tokenFromMail();

        const ok = await dispatch('post', '/password/reset', { body: { token, newPassword: 'a-brand-new-passphrase' } });
        expect(ok.res.statusCode).toBe(200);
        expect((await dispatch('get', '/me', { cookies: { das_session: cookie } })).res.statusCode).toBe(401);
        expect((await loginAs('alice', 'op-password-1')).statusCode).toBe(401);
        expect((await loginAs('alice', 'a-brand-new-passphrase')).statusCode).toBe(200);
        await flush();
        expect(mails.some(([k, m]) => k === 'changed' && m.to === 'alice@example.com')).toBe(true);

        const again = await dispatch('post', '/password/reset', { body: { token, newPassword: 'another-new-passphrase' } });
        expect(again.res.statusCode).toBe(400);
        expect(again.res.body.error).toBe('INVALID_TOKEN');
      });

      it('a weak password is refused WITHOUT burning the token; a garbage token is refused', async () => {
        await dispatch('post', '/password/forgot', { body: { login: 'alice' } });
        await flush();
        const token = tokenFromMail();
        const weak = await dispatch('post', '/password/reset', { body: { token, newPassword: 'short' } });
        expect(weak.res.statusCode).toBe(400);
        expect(weak.res.body).toMatchObject({ error: 'WEAK_PASSWORD' });
        expect((await dispatch('post', '/password/reset', { body: { token, newPassword: 'a-brand-new-passphrase' } })).res.statusCode).toBe(200);

        const bad = await dispatch('post', '/password/reset', { body: { token: 'x'.repeat(43), newPassword: 'a-brand-new-passphrase' } });
        expect(bad.res.body.error).toBe('INVALID_TOKEN');
      });

      it('a new request cancels the previous link', async () => {
        await dispatch('post', '/password/forgot', { body: { login: 'alice' } });
        await flush();
        const first = tokenFromMail();
        mails.length = 0;
        await dispatch('post', '/password/forgot', { body: { login: 'alice' } });
        await flush();
        expect((await dispatch('post', '/password/reset', { body: { token: first, newPassword: 'a-brand-new-passphrase' } })).res.statusCode).toBe(400);
        expect((await dispatch('post', '/password/reset', { body: { token: tokenFromMail(), newPassword: 'a-brand-new-passphrase' } })).res.statusCode).toBe(200);
      });
    });

    describe('TOTP enrollment ownership (A08)', () => {
      it("a user cannot activate someone else's pending authenticator", async () => {
        const rootCookie = sessionCookieFrom(await loginAs('root', 'admin-password-1'));
        const start = await dispatch('post', '/totp/enroll/start', { cookies: { das_session: rootCookie }, body: { name: 'root-phone' } });

        const aliceCookie = sessionCookieFrom(await loginAs('alice', 'op-password-1'));
        const attack = await dispatch('post', '/totp/enroll/verify', {
          cookies: { das_session: aliceCookie },
          body: { authenticatorId: start.res.body.authenticatorId, code: auth.generateTotp(start.res.body.secret) },
        });
        expect(attack.res.statusCode).toBe(400);
        const stillPending = auth.listAuthenticators(db, auth.findUserByUsername(db, 'root').id)[0];
        expect(stillPending.status).toBe('pending');
      });
    });

    describe('logo upload (A03/B11)', () => {
      // The multipart parsing itself (multer) needs a real socket: see the supertest cases in
      // server.smoke.test.js. Here only what happens BEFORE the body is touched.
      it('still requires authentication, before any body is read', async () => {
        const { res } = await dispatch('post', '/assets/1/logo', { headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: Buffer.from('x') });
        expect(res.statusCode).toBe(401);
      });
    });

    describe('CSP nonce reaches the rendered pages (A01)', () => {
      it('GET /login puts the per-request nonce on its inline script', async () => {
        const { res } = await dispatch('get', '/login');
        expect(res.body).toContain('<script nonce="test-nonce">');
        expect(res.body).not.toContain('<script>');
      });

      it('the password-reset pages carry the nonce too, and the login page links to them', async () => {
        for (const page of ['/forgot-password', '/reset-password']) {
          const { res } = await dispatch('get', page);
          expect(res.statusCode).toBe(200);
          expect(res.body).toContain('<script nonce="test-nonce">');
          expect(res.body).not.toContain('<script>');
        }
        const login = await dispatch('get', '/login');
        expect(login.res.body).toContain('href="/forgot-password"');
      });

      it('/reset-password is never cached and never leaks a Referer; the token is read from the fragment only', async () => {
        const { res } = await dispatch('get', '/reset-password');
        expect(res.headers['Referrer-Policy']).toBe('no-referrer');
        expect(res.headers['Cache-Control']).toBe('no-store');
        expect(res.body).toContain('location.hash');
        expect(res.body).toContain('history.replaceState');
        expect(res.body).not.toContain('location.search');
      });
    });
  });
});
