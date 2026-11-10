import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

import { createSqliteAdapter } from '../src/database/index.js';
import { createUser } from '../src/auth/users.js';
import { hashSessionId, destroyUserSessions } from '../src/auth/sessions.js';
import { createSessionStore } from '../src/auth/session-store.js';
import { deriveCookieSecret, attachUser, establishSession, endSession } from '../src/http/session.js';

// express-session's Store base class is only an EventEmitter with helpers; the real module is
// exercised over HTTP by the workshop smoke test.
class Store extends EventEmitter {}
const stub = { Store };

const p = (fn) => new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value))));
const later = (iso, ms) => new Date(new Date(iso).getTime() + ms).toISOString();

describe('SQLite session store for express-session', () => {
  let db;
  let alice;
  let store;
  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    alice = createUser(db, { username: 'alice', passwordHash: 'h' });
    store = createSessionStore({ db, expressSession: stub, ttlMs: 60_000, idleTimeoutMs: 0 });
  });
  afterEach(() => db.close());

  const sess = (extra = {}) => ({ cookie: { expires: new Date(Date.now() + 60_000).toISOString(), httpOnly: true }, ...extra });

  it('round-trips a session; the row is keyed by the hash and carries the user id', async () => {
    await p((cb) => store.set('sid-1', sess({ userId: alice.id, user: { id: alice.id, role: 'admin' } }), cb));
    const back = await p((cb) => store.get('sid-1', cb));
    expect(back.user.role).toBe('admin');
    const rows = db.all('SELECT id, user_id FROM sessions');
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(hashSessionId('sid-1'));
    expect(rows[0].user_id).toBe(alice.id);
    expect(await p((cb) => store.get('nope', cb))).toBe(null);
  });

  it('set again updates in place; an anonymous session (no user) is allowed; a pending MFA session belongs to its user', async () => {
    await p((cb) => store.set('a', sess({ n: 1 }), cb));
    await p((cb) => store.set('a', sess({ n: 2 }), cb));
    expect((await p((cb) => store.get('a', cb))).n).toBe(2);
    expect(db.get('SELECT user_id FROM sessions').user_id).toBe(null);
    await p((cb) => store.set('m', sess({ pendingUserId: alice.id, mfaPending: true }), cb));
    expect(db.get('SELECT user_id FROM sessions WHERE id = ?', [hashSessionId('m')]).user_id).toBe(alice.id);
  });

  it('K04: with isUserActive a late save cannot resurrect the session of a revoked user', async () => {
    const guarded = createSessionStore({ db, expressSession: { Store: class {} }, isUserActive: (id) => id !== alice.id });
    await p((cb) => guarded.set('late', sess({ userId: alice.id }), cb));
    expect(db.get('SELECT COUNT(*) AS n FROM sessions WHERE id = ?', [hashSessionId('late')]).n).toBe(0);
    await p((cb) => guarded.set('anon', sess({}), cb));
    expect(db.get('SELECT COUNT(*) AS n FROM sessions WHERE id = ?', [hashSessionId('anon')]).n).toBe(1);
  });

  it('K05: attachUser with revalidate swaps in the fresh user, drops a disabled one, and caches', async () => {
    let calls = 0;
    let fresh = { id: 5, role: 'viewer' };
    let t = 0;
    const mw = attachUser({ revalidate: () => { calls += 1; return fresh; }, cacheMs: 1000, now: () => t });
    const run = async () => { const req = { session: { userId: 5, user: { id: 5, role: 'admin' } } }; await mw(req, {}, () => {}); return req.user; };
    expect((await run()).role).toBe('viewer');
    await run();
    expect(calls).toBe(1);
    // a NEW session of the same user (e.g. after a password change) must not get the old session's cached snapshot
    const other = { sessionID: 'other', session: { userId: 5, user: { id: 5, role: 'admin', mustChangePassword: false } } };
    const first = { sessionID: 'first', session: { userId: 5, user: { id: 5, role: 'viewer', mustChangePassword: true } } };
    const mw2 = attachUser({ revalidate: (id, snap) => snap });
    await mw2(first, {}, () => {});
    await mw2(other, {}, () => {});
    expect(first.user.mustChangePassword).toBe(true);
    expect(other.user.mustChangePassword).toBe(false);
    fresh = null; t = 2000;
    expect(await run()).toBe(null);
    expect(calls).toBe(2);
  });

  it('destroy removes it; length and clear work', async () => {
    await p((cb) => store.set('a', sess(), cb));
    await p((cb) => store.set('b', sess(), cb));
    expect(await p((cb) => store.length(cb))).toBe(2);
    await p((cb) => store.destroy('a', cb));
    expect(await p((cb) => store.get('a', cb))).toBe(null);
    await p((cb) => store.clear(cb));
    expect(await p((cb) => store.length(cb))).toBe(0);
  });

  it('an expired session is gone and its row is deleted', async () => {
    await p((cb) => store.set('old', { cookie: { expires: new Date(Date.now() - 1000).toISOString() }, userId: alice.id }, cb));
    expect(await p((cb) => store.get('old', cb))).toBe(null);
    expect(db.all('SELECT id FROM sessions').length).toBe(0);
  });

  it('idle timeout: unused sessions die, touch keeps one alive, touch is throttled', async () => {
    const idle = createSessionStore({ db, expressSession: stub, ttlMs: 3_600_000, idleTimeoutMs: 10_000, touchIntervalMs: 60_000 });
    await p((cb) => idle.set('s', sess({ userId: alice.id }), cb));
    const key = hashSessionId('s');
    const seen = () => db.get('SELECT last_seen_at AS t FROM sessions WHERE id = ?', [key]).t;

    const t0 = seen();
    await p((cb) => idle.touch('s', sess(), cb));
    expect(seen()).toBe(t0); // too soon: no write

    db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [later(t0, -6_000), key]);
    await p((cb) => idle.touch('s', sess(), cb));
    expect(seen() === later(t0, -6_000)).toBe(false); // older than half the window: refreshed
    expect(await p((cb) => idle.get('s', cb))).toBeTruthy();

    db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [later(t0, -11_000), key]);
    expect(await p((cb) => idle.get('s', cb))).toBe(null);
  });

  it('destroyUserSessions (password change, role change) reaches express-session rows, sparing the caller', async () => {
    await p((cb) => store.set('x1', sess({ userId: alice.id }), cb));
    await p((cb) => store.set('x2', sess({ userId: alice.id }), cb));
    await p((cb) => store.set('x3', sess({ pendingUserId: alice.id }), cb));
    expect(destroyUserSessions(db, alice.id, { exceptSessionId: 'x2' })).toBe(2);
    expect(await p((cb) => store.get('x2', cb))).toBeTruthy();
    expect(store.destroyUserSessions(alice.id)).toBe(1);
  });

  it('purgeExpired removes expired rows', async () => {
    await p((cb) => store.set('live', sess(), cb));
    db.run(`INSERT INTO sessions (id, user_id, created_at, expires_at, data) VALUES ('h1:dead', NULL, ?, ?, '{}')`, [new Date().toISOString(), new Date(Date.now() - 1000).toISOString()]);
    expect(store.purgeExpired()).toBe(1);
    expect(db.all('SELECT id FROM sessions').length).toBe(1);
  });

  it('refuses to be built without a database', () => {
    expect(() => createSessionStore({ expressSession: stub })).toThrow();
  });
});

describe('session helpers', () => {
  function fakeReq() {
    const calls = [];
    const req = {
      sessionID: 'old',
      session: {
        cookie: { maxAge: 1000 },
        regenerate(cb) {
          calls.push('regenerate');
          req.sessionID = 'new';
          req.session = { cookie: { maxAge: 1000 }, regenerate: this.regenerate, save: this.save, destroy: this.destroy };
          cb();
        },
        save(cb) { calls.push('save'); cb(); },
        destroy(cb) { calls.push('destroy'); delete req.session; cb(); },
      },
    };
    return { req, calls };
  }

  it('deriveCookieSecret is stable, differs per secret and is not the secret itself', () => {
    const a = deriveCookieSecret('0123456789abcdef');
    expect(a).toBe(deriveCookieSecret('0123456789abcdef'));
    expect(a === deriveCookieSecret('0123456789abcdeg')).toBe(false);
    expect(a.includes('0123456789abcdef')).toBe(false);
    expect(a.length).toBe(64);
    expect(() => deriveCookieSecret('short')).toThrow();
    expect(() => deriveCookieSecret(undefined)).toThrow();
  });

  it('establishSession regenerates the id first, then stores the user, then saves', async () => {
    const { req, calls } = fakeReq();
    const sid = await establishSession(req, { userId: 5, user: { id: 5 }, data: { flag: true }, maxAgeMs: 300_000 });
    expect(calls).toEqual(['regenerate', 'save']);
    expect(sid).toBe('new');
    expect(req.session.userId).toBe(5);
    expect(req.session.user.id).toBe(5);
    expect(req.session.flag).toBe(true);
    expect(req.session.cookie.maxAge).toBe(300_000);
  });

  it('establishSession without a session middleware fails loudly', async () => {
    let failed = false;
    try { await establishSession({}, { userId: 1 }); } catch { failed = true; }
    expect(failed).toBe(true);
  });

  it('endSession destroys the session and clears the cookie; works without a session too', async () => {
    const { req, calls } = fakeReq();
    const cleared = [];
    const res = { clearCookie: (...a) => cleared.push(a) };
    await endSession(req, res);
    expect(calls).toEqual(['destroy']);
    expect(cleared[0][0]).toBe('das_session');
    await endSession({}, res);
    expect(cleared.length).toBe(2);
  });

  it('attachUser reads req.session.user only', () => {
    const run = (req) => { attachUser()(req, {}, () => {}); return req.user; };
    expect(run({ session: { user: { id: 1 } }, body: { user: { id: 99 } } }).id).toBe(1);
    expect(run({})).toBe(null);
    expect(run({ session: {} })).toBe(null);
  });
});
