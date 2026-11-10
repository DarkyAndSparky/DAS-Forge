import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';

import { createLogger, accessLog } from '../src/logs/index.js';
import { errorPageHandler } from '../src/http/error-pages.js';
import { registerFatalHandlers, registerGracefulShutdown } from '../src/http/bootstrap.js';
import { createSseHandler, closeAllSseStreams } from '../src/realtime/sse-transport.js';
import { createEventBus } from '../src/realtime/event-bus.js';
import { healthHandler } from '../src/health/route.js';
import { createSqliteAdapter } from '../src/database/index.js';
import { createUser } from '../src/auth/users.js';
import { startTotpEnrollment, verifyTotpEnrollment, verifyTotpLogin } from '../src/auth/authenticators.js';
import { generateTotp, matchTotpStep } from '../src/auth/totp.js';

/** Audit wave 3a: C01 (SSE shutdown), C02 (fatal handlers), C03 (logger), C04 (error handler), C06 (SSE limits), C08 (health), A07 (TOTP replay). */

function sink() {
  const lines = [];
  return { lines, write: (l) => lines.push(l), parsed: () => lines.map((l) => JSON.parse(l)) };
}

describe('logger (C03)', () => {
  it('writes one JSON line with time, level, bindings and message', () => {
    const s = sink();
    const log = createLogger({ stream: s, base: { app: 'x' }, now: () => new Date('2026-01-01T00:00:00Z') });
    log.info('hello', { n: 1 });
    expect(s.parsed()).toEqual([{ time: '2026-01-01T00:00:00.000Z', level: 'info', app: 'x', n: 1, msg: 'hello' }]);
  });

  it('respects the level threshold', () => {
    const s = sink();
    const log = createLogger({ stream: s, level: 'warn' });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(s.parsed().map((l) => l.level)).toEqual(['warn', 'error']);
    const quiet = sink();
    createLogger({ stream: quiet, level: 'silent' }).error('x');
    expect(quiet.lines).toEqual([]);
    expect(() => createLogger({ level: 'loud' })).toThrow(/unknown level/);
  });

  it('redacts credential-looking keys at any depth, including headers', () => {
    const s = sink();
    createLogger({ stream: s }).info('req', {
      headers: { authorization: 'Bearer abc', cookie: 'das_session=zzz', accept: 'x' },
      body: { username: 'bob', password: 'hunter2', deep: { sessionSecret: 's', list: [{ apiKey: 'k' }] } },
    });
    const line = s.lines[0];
    for (const secret of ['Bearer abc', 'das_session=zzz', 'hunter2', '"s"', '"k"']) expect(line).not.toContain(secret);
    expect(JSON.parse(line).body.username).toBe('bob');
  });

  it('serialises Error objects and survives circular structures and a throwing stream', () => {
    const s = sink();
    const log = createLogger({ stream: s });
    const a = {};
    a.self = a;
    log.error(new Error('boom'), 'failed');
    log.info('c', a);
    const [e, c] = s.parsed();
    expect(e.err).toMatchObject({ name: 'Error', message: 'boom' });
    expect(e.msg).toBe('failed');
    expect(c.self.self).toBe('[Circular]');
    expect(() => createLogger({ stream: { write: () => { throw new Error('disk'); } } }).info('x')).not.toThrow();
  });

  it('child() adds bindings without changing the parent', () => {
    const s = sink();
    const log = createLogger({ stream: s });
    log.child({ requestId: 'r1' }).info('a');
    log.info('b');
    expect(s.parsed()[0].requestId).toBe('r1');
    expect(s.parsed()[1].requestId).toBeUndefined();
  });
});

describe('accessLog (C03, pino-http)', () => {
  /** Real HTTP round-trip: pino-http needs a real request/response pair. */
  async function hit({ url, status = 200, id, opts }) {
    const s = sink();
    let seenLog;
    const middleware = accessLog(createLogger({ stream: s }), opts);
    const server = http.createServer((req, res) => {
      if (id) req.id = id;
      middleware(req, res, () => {
        seenLog = req.log;
        res.statusCode = status;
        res.end('x');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { headers: { cookie: 'das_session=zzz', 'user-agent': 'ua-test' } });
      await r.arrayBuffer();
      // the server writes the line when the response finishes; give it a moment
      for (let i = 0; i < 50 && s.lines.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      await new Promise((resolve) => setTimeout(resolve, 30)); // and make sure it is not written twice
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    return { s, seenLog };
  }

  it('logs method, path WITHOUT the query string, status, request id - once, and never headers', async () => {
    const { s, seenLog } = await hit({ url: '/search?token=SECRET&q=x', id: 'req-1' });
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).not.toContain('SECRET');
    expect(s.lines[0]).not.toContain('das_session');
    expect(s.parsed()[0]).toMatchObject({
      msg: 'request',
      level: 'info',
      req: { id: 'req-1', method: 'GET', path: '/search', userAgent: 'ua-test' },
      status: 200,
    });
    expect(typeof s.parsed()[0].responseTime).toBe('number');
    expect(typeof seenLog.info).toBe('function');
  });

  it('generates a request id when none exists', async () => {
    const { s } = await hit({ url: '/x' });
    expect(s.parsed()[0].req.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('uses info for 4xx, warn for 429 and error for 5xx; skip() suppresses the line but still attaches req.log', async () => {
    expect((await hit({ url: '/x', status: 404 })).s.parsed()[0].level).toBe('info');
    expect((await hit({ url: '/x', status: 429 })).s.parsed()[0].level).toBe('warn');
    expect((await hit({ url: '/x', status: 503 })).s.parsed()[0].level).toBe('error');
    const skipped = await hit({ url: '/health', opts: { skip: (r) => r.url === '/health' } });
    expect(skipped.s.lines).toEqual([]);
    expect(skipped.seenLog).toBeTruthy();
  });
});

describe('errorPageHandler (C04)', () => {
  const vendor = { name: 'T', getLogo: () => null, readLogo: () => null };
  function call(err, req = {}, opts) {
    const logs = sink();
    const res = {
      headersSent: false,
      statusCode: null,
      body: null,
      status(c) { this.statusCode = c; return this; },
      type() { return this; },
      send(b) { this.body = b; return this; },
      json(b) { this.body = b; this.json_ = true; return this; },
    };
    if (req.res) Object.assign(res, req.res);
    let nexted;
    const handler = errorPageHandler(vendor, { logger: createLogger({ stream: logs }), ...opts });
    handler(err, { id: 'rid', path: '/p', headers: {}, ...req }, res, (e) => (nexted = e));
    return { res, logs, nexted };
  }

  it('delegates to Express when the response already started (SSE/stream)', () => {
    const err = new Error('late');
    const { nexted, res } = call(err, { res: { headersSent: true } });
    expect(nexted).toBe(err);
    expect(res.statusCode).toBeNull();
  });

  it('only trusts a 4xx/5xx status, otherwise 500', () => {
    for (const bad of [200, 302, 99, 600, 'abc', NaN, undefined, -1]) {
      expect(call(Object.assign(new Error('x'), { statusCode: bad })).res.statusCode).toBe(500);
    }
    expect(call(Object.assign(new Error('x'), { statusCode: 404 })).res.statusCode).toBe(404);
    expect(call(Object.assign(new Error('x'), { status: 413 })).res.statusCode).toBe(413);
  });

  it('exposes err.message only for expose:true 4xx errors, never for 5xx or plain errors', () => {
    const secret = 'SQLITE_ERROR: no such table users';
    expect(call(Object.assign(new Error(secret), { statusCode: 400 })).res.body).not.toContain(secret);
    expect(call(Object.assign(new Error(secret), { statusCode: 500, expose: true })).res.body).not.toContain(secret);
    expect(call(Object.assign(new Error('request entity too large'), { statusCode: 413, expose: true })).res.body).toContain('request entity too large');
  });

  it('answers JSON to API clients and HTML to browsers', () => {
    const j = call(new Error('x'), { headers: { accept: 'application/json' } });
    expect(j.res.json_).toBe(true);
    expect(j.res.body).toMatchObject({ error: 'INTERNAL_ERROR', requestId: 'rid' });
    const posted = call(new Error('x'), { headers: { 'content-type': 'application/json' } });
    expect(posted.res.json_).toBe(true);
    const h = call(new Error('x'), { headers: { accept: 'text/html,application/xhtml+xml,application/json;q=0.5' } });
    expect(h.res.json_).toBeUndefined();
    expect(typeof h.res.body).toBe('string');
  });

  it('logs 5xx with the request id and the stack, but 4xx not at error level', () => {
    const five = call(new Error('db down'));
    const rec = five.logs.parsed()[0];
    expect(rec).toMatchObject({ level: 'error', requestId: 'rid', msg: 'unhandled error' });
    expect(rec.err.stack).toContain('db down');
    expect(call(Object.assign(new Error('bad'), { statusCode: 400 })).logs.lines).toEqual([]);
  });
});

describe('SSE lifecycle (C01, C06)', () => {
  function fakeRes() {
    const res = new EventEmitter();
    res.chunks = [];
    res.ended = false;
    res.writeHead = () => {};
    res.flushHeaders = () => {};
    res.write = (c) => { res.chunks.push(c); return true; };
    res.end = () => { res.ended = true; res.emit('close'); };
    res.writableLength = 0;
    return res;
  }

  it('closeAllSseStreams() sends a shutdown event, ends every open stream and unsubscribes', () => {
    const bus = createEventBus();
    const handler = createSseHandler({ eventBus: bus, resolveChannel: () => 'c', heartbeatMs: 60_000 });
    const [a, b] = [fakeRes(), fakeRes()];
    handler(new EventEmitter(), a);
    handler(new EventEmitter(), b);
    expect(bus.subscriberCount('c')).toBe(2);
    expect(closeAllSseStreams()).toBe(2);
    for (const r of [a, b]) {
      expect(r.chunks.join('')).toContain('event: shutdown');
      expect(r.ended).toBe(true);
    }
    expect(bus.subscriberCount('c')).toBe(0);
    expect(closeAllSseStreams()).toBe(0);
  });

  it('refuses a new stream beyond maxClients with 503 + Retry-After, and frees the slot on close', () => {
    const bus = createEventBus();
    const handler = createSseHandler({ eventBus: bus, resolveChannel: () => 'c', heartbeatMs: 60_000, maxClients: 1 });
    const first = fakeRes();
    handler(new EventEmitter(), first);
    const second = fakeRes();
    let status, headers;
    second.status = (c) => { status = c; return second; };
    second.set = (k, v) => { headers = { [k]: v }; return second; };
    second.json = () => second;
    handler(new EventEmitter(), second);
    expect(status).toBe(503);
    expect(headers).toEqual({ 'Retry-After': '5' });
    first.emit('close');
    const third = fakeRes();
    handler(new EventEmitter(), third);
    expect(third.chunks).toBeDefined();
    expect(bus.subscriberCount('c')).toBe(1);
    closeAllSseStreams();
  });

  it('an initialEvent that throws ends the response instead of leaving it hanging', () => {
    const bus = createEventBus();
    const handler = createSseHandler({ eventBus: bus, resolveChannel: () => 'c', heartbeatMs: 60_000, initialEvent: () => { throw new Error('snapshot failed'); } });
    const res = fakeRes();
    const origError = console.error;
    console.error = () => {};
    try {
      handler(new EventEmitter(), res);
    } finally {
      console.error = origError;
    }
    expect(res.ended).toBe(true);
    expect(bus.subscriberCount('c')).toBe(0);
  });

  it('drops a client whose write buffer grows past maxBufferedBytes (slow consumer)', () => {
    const bus = createEventBus();
    const handler = createSseHandler({ eventBus: bus, resolveChannel: () => 'c', heartbeatMs: 60_000, maxBufferedBytes: 10 });
    const res = fakeRes();
    res.destroy = () => { res.destroyed = true; };
    handler(new EventEmitter(), res);
    res.writableLength = 100; // the socket is not draining
    bus.publish('c', { big: 'x' });
    expect(res.destroyed).toBe(true);
    expect(bus.subscriberCount('c')).toBe(0);
  });
});

describe('health readiness (C08)', () => {
  let db;
  beforeEach(() => { db = createSqliteAdapter({ file: ':memory:' }); });
  afterEach(() => db.close());
  const call = (opts) => {
    const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    healthHandler(db, opts)({}, res);
    return res;
  };

  it('flips to 503 shutting_down as soon as shutdown starts', () => {
    let down = false;
    expect(call({ isShuttingDown: () => down }).code).toBe(200);
    down = true;
    expect(call({ isShuttingDown: () => down })).toMatchObject({ code: 503, body: { status: 'shutting_down' } });
  });

  it('minimal mode hides version and uptime', () => {
    const body = call({ version: '1.2.3', minimal: true }).body;
    expect(body).toEqual({ status: 'ok', database: 'ok' });
    expect(call({ version: '1.2.3' }).body.version).toBe('1.2.3');
  });
});

describe('fatal handlers + lifecycle (C02)', () => {
  it('routes uncaughtException and unhandledRejection through the graceful shutdown with a log line', () => {
    const proc = new EventEmitter();
    const calls = [];
    const s = sink();
    registerFatalHandlers({ shutdown: (k) => calls.push(k) }, { logger: createLogger({ stream: s }), proc });
    proc.emit('uncaughtException', new Error('kaboom'));
    proc.emit('unhandledRejection', 'plain string reason');
    expect(calls).toEqual(['uncaughtException', 'unhandledRejection']);
    expect(s.parsed().map((l) => l.msg)).toEqual(['fatal: uncaughtException', 'fatal: unhandledRejection']);
    expect(s.parsed()[0].err.message).toBe('kaboom');
  });

  it('registerGracefulShutdown exposes isShuttingDown()', async () => {
    const server = { close: (cb) => cb(), closeIdleConnections() {} };
    const life = registerGracefulShutdown(server, { signals: [], exit: () => {} });
    expect(life.isShuttingDown()).toBe(false);
    const done = life.shutdown('SIGTERM');
    expect(life.isShuttingDown()).toBe(true);
    await done;
  });
});

describe('TOTP replay protection (A07)', () => {
  let db, userId, secret, authId;
  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    userId = createUser(db, { username: 'u', passwordHash: 'x', role: 'operator' }).id;
    const e = startTotpEnrollment(db, userId, { accountName: 'u' });
    secret = e.secret;
    authId = e.authenticatorId;
    expect(verifyTotpEnrollment(db, authId, generateTotp(secret), { userId })).toBe(true);
  });
  afterEach(() => db.close());

  it('matchTotpStep reports the matching step, null otherwise', () => {
    const at = 1_700_000_000;
    expect(matchTotpStep(secret, generateTotp(secret, { at }), { at })).toBe(Math.floor(at / 30));
    expect(matchTotpStep(secret, generateTotp(secret, { at: at - 30 }), { at })).toBe(Math.floor(at / 30) - 1);
    expect(matchTotpStep(secret, '000000', { at })).toBeNull();
    expect(matchTotpStep(secret, 'abcdef', { at })).toBeNull();
  });

  it('the same code works once at login, a second use is refused', () => {
    const code = generateTotp(secret);
    expect(verifyTotpLogin(db, userId, code)).toBe(authId);
    expect(verifyTotpLogin(db, userId, code)).toBeNull();
  });

  it('an OLDER step than the last accepted one is refused too (no going backwards)', () => {
    const now = Math.floor(Date.now() / 1000);
    // accept the next window's code first, then try the current one
    const future = generateTotp(secret, { at: now + 30 });
    expect(verifyTotpLogin(db, userId, future)).toBe(authId);
    expect(verifyTotpLogin(db, userId, generateTotp(secret, { at: now }))).toBeNull();
  });

  it('a wrong code does not consume anything: the right one still works afterwards', () => {
    expect(verifyTotpLogin(db, userId, '000000')).toBeNull();
    expect(verifyTotpLogin(db, userId, generateTotp(secret))).toBe(authId);
  });

  it('adds last_used_step to a totp_credentials table created before this column existed', () => {
    const old = createSqliteAdapter({ file: ':memory:' });
    const u = createUser(old, { username: 'o', passwordHash: 'x', role: 'operator' }).id;
    old.exec('DROP TABLE totp_credentials');
    old.exec('CREATE TABLE totp_credentials (authenticator_id INTEGER PRIMARY KEY REFERENCES authenticators(id) ON DELETE CASCADE, secret TEXT NOT NULL, period INTEGER NOT NULL DEFAULT 30)');
    const e = startTotpEnrollment(old, u, { accountName: 'o' });
    expect(old.all('PRAGMA table_info(totp_credentials)').some((c) => c.name === 'last_used_step')).toBe(true);
    expect(e.authenticatorId).toBeTruthy();
    old.close();
  });
});
