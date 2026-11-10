import { describe, it, expect, afterEach } from 'vitest';
import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createBufferedSink,
  createFileSink,
  createHttpSink,
  createSyslogSink,
  formatSyslog,
  resolveEnvRef,
} from '../src/logs/sinks.js';
import { createLogDestination, streamOfLine } from '../src/logs/destination.js';
import { mirrorAuditToLogs, logAuditAnchor } from '../src/logs/audit-mirror.js';
import { createSqliteAdapter } from '../src/database/index.js';
import { log as auditLog, onEntry, anchor, verifyChain } from '../src/audit/index.js';
import { createCli } from '../src/cli/index.js';
import { registerAuditCommands } from '../src/cli/commands/audit.js';
import { ApplicationConfigSchema } from '../src/config/schema.js';

/** Audit 0.1.81: log sinks (syslog UDP/TCP, HTTP formats, file), buffering, routing, audit mirror, `audit verify`. */

const line = (over = {}) => JSON.stringify({ level: 'info', time: '2026-01-01T00:00:00.000Z', msg: 'hello', ...over }) + '\n';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};
const fast = { flushIntervalMs: 5, retryBaseMs: 10, retryMaxMs: 40, warn: quiet };

async function waitFor(fn, ms = 2000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
}

const cleanups = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'das-logs-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

describe('helpers', () => {
  it('formatSyslog builds an RFC 5424 message with the severity from the level', () => {
    const m = formatSyslog(line({ level: 'error' }), { facility: 16, appName: 'my app', hostname: 'h 1', pid: 7, now: () => new Date('2026-01-01T00:00:00Z') });
    expect(m.startsWith('<131>1 2026-01-01T00:00:00.000Z h_1 my_app 7 - - {')).toBe(true); // 16*8+3
    expect(formatSyslog(line({ level: 'info' }), {}).startsWith('<134>1 ')).toBe(true);
    expect(m.endsWith('\n')).toBe(false);
  });
  it('resolveEnvRef reads env:NAME and refuses a missing variable', () => {
    expect(resolveEnvRef('env:TOK', { TOK: 'abc' })).toBe('abc');
    expect(resolveEnvRef('plain')).toBe('plain');
    expect(() => resolveEnvRef('env:NOPE', {})).toThrow(/NOPE/);
  });
  it('streamOfLine: explicit stream wins, request lines are access, the rest is app', () => {
    expect(streamOfLine('{"level":"info","stream":"audit","msg":"audit"}')).toBe('audit');
    expect(streamOfLine('{"level":"info","msg":"request","status":200}')).toBe('access');
    expect(streamOfLine(line())).toBe('app');
  });
});

describe('buffered sink', () => {
  it('drops the oldest lines when full, counts them, and spills to a fallback when given', async () => {
    const spilled = [];
    const s = createBufferedSink({ name: 't', maxLines: 100, batchSize: 1000, flushIntervalMs: 60_000, send: async () => { throw new Error('down'); }, spill: (l) => spilled.push(...l), warn: quiet });
    for (let i = 0; i < 105; i++) s.write(`l${i}\n`);
    expect(s.stats().queued < 101).toBe(true);
    expect(s.stats().spilled).toBeGreaterThan(0);
    expect(spilled[0]).toBe('l0\n');
    const plain = createBufferedSink({ name: 'p', maxLines: 100, batchSize: 1000, flushIntervalMs: 60_000, send: async () => {}, warn: quiet });
    for (let i = 0; i < 150; i++) plain.write(`l${i}\n`);
    expect(plain.stats().dropped).toBeGreaterThan(0);
    await s.close({ timeoutMs: 50 });
    await plain.close({ timeoutMs: 50 });
  });
  it('retries with backoff and delivers everything in order once the destination returns', async () => {
    const got = [];
    let up = false;
    const s = createBufferedSink({ name: 'r', ...fast, send: async (b) => { if (!up) throw new Error('down'); got.push(...b); } });
    for (let i = 0; i < 5; i++) s.write(`l${i}\n`);
    await sleep(60);
    expect(got).toEqual([]);
    expect(s.stats().failures).toBeGreaterThan(0);
    up = true;
    expect(await waitFor(() => got.length === 5)).toBe(true);
    expect(got).toEqual(['l0\n', 'l1\n', 'l2\n', 'l3\n', 'l4\n']);
    expect(s.stats().sent).toBe(5);
    await s.close();
  });
  it('a permanent refusal drops the batch instead of retrying forever', async () => {
    let calls = 0;
    const s = createBufferedSink({ name: 'x', ...fast, send: async () => { calls++; const e = new Error('HTTP 400'); e.permanent = true; throw e; } });
    s.write('a\n');
    expect(await waitFor(() => s.stats().dropped === 1)).toBe(true);
    await sleep(50);
    expect(calls).toBe(1);
    await s.close();
  });
  it('write never throws and close flushes what it can', async () => {
    const got = [];
    const s = createBufferedSink({ name: 'c', flushIntervalMs: 60_000, send: async (b) => got.push(...b), warn: quiet });
    s.write('one\n');
    s.write('two\n');
    await s.close();
    expect(got).toEqual(['one\n', 'two\n']);
    expect(() => s.write('after close\n')).not.toThrow();
  });
});

describe('file sink', () => {
  it('appends with 0600 and rotates before passing maxBytes', async () => {
    const dir = tmp();
    const file = path.join(dir, 'sub', 'app.log');
    const s = createFileSink({ file, maxBytes: 200, keep: 2, ...fast });
    for (let i = 0; i < 12; i++) {
      s.write(`${'x'.repeat(60)}-${i}\n`);
      await s.flush();
    }
    await s.close();
    const files = readdirSync(path.join(dir, 'sub')).sort();
    expect(files).toEqual(['app.log', 'app.log.1', 'app.log.2']);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain('-11');
  });
});

describe('syslog sink', () => {
  it('TCP: octet-counted RFC 5424 frames, reconnects after the server restarts', async () => {
    const received = [];
    const connections = [];
    const server = net.createServer((sock) => {
      connections.push(sock);
      sock.on('data', (d) => received.push(d.toString()));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    cleanups.push(() => { connections.forEach((c) => c.destroy()); server.close(); });

    const s = createSyslogSink({ host: '127.0.0.1', port, protocol: 'tcp', appName: 'wk', hostname: 'host', ...fast });
    s.write(line({ level: 'warn', msg: 'one' }));
    await s.flush();
    expect(await waitFor(() => received.join('').includes('one'))).toBe(true);
    const text = received.join('');
    const m = /^(\d+) (<\d+>1 [^\n]+)$/.exec(text.trim());
    expect(m).not.toBe(null);
    expect(Number(m[1])).toBe(Buffer.byteLength(m[2]));
    expect(m[2].startsWith('<132>1 ')).toBe(true); // facility 16*8 + warn 4
    expect(m[2]).toContain(' host wk ');

    connections.forEach((c) => c.destroy()); // server drops the connection
    await sleep(30);
    s.write(line({ msg: 'two' }));
    await s.flush();
    s.write(line({ msg: 'three' }));
    expect(await waitFor(() => received.join('').includes('three'))).toBe(true);
    await s.close();
  });

  it('UDP: one datagram per line', async () => {
    const got = [];
    const sock = dgram.createSocket('udp4');
    sock.on('message', (m) => got.push(m.toString()));
    await new Promise((r) => sock.bind(0, '127.0.0.1', r));
    cleanups.push(() => sock.close());
    const s = createSyslogSink({ host: '127.0.0.1', port: sock.address().port, protocol: 'udp', ...fast });
    s.write(line({ msg: 'a' }));
    s.write(line({ msg: 'b' }));
    await s.flush();
    expect(await waitFor(() => got.length === 2)).toBe(true);
    expect(got[0]).toContain('"msg":"a"');
    await s.close();
  });
});

describe('http sink', () => {
  async function receiver(handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const r = { url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
        requests.push(r);
        const status = handler ? handler(r, requests.length) : 204;
        res.writeHead(status).end();
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => server.close(r)));
    return { requests, url: `http://127.0.0.1:${server.address().port}/in` };
  }

  it('ndjson with an env: header', async () => {
    const { requests, url } = await receiver();
    const s = createHttpSink({ url, format: 'ndjson', headers: { authorization: 'env:LOG_TOKEN' }, env: { LOG_TOKEN: 'Bearer s3cret' }, ...fast });
    s.write(line({ msg: 'a' }));
    s.write(line({ msg: 'b' }));
    await s.flush();
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.authorization).toBe('Bearer s3cret');
    expect(requests[0].headers['content-type']).toBe('application/x-ndjson');
    expect(requests[0].body.trim().split('\n').map((l) => JSON.parse(l).msg)).toEqual(['a', 'b']);
    await s.close();
  });

  it('loki, elastic-bulk and splunk-hec bodies', async () => {
    const { requests, url } = await receiver();
    for (const format of ['loki', 'elastic-bulk', 'splunk-hec']) {
      const s = createHttpSink({ url, format, labels: { app: 'wk' }, index: 'logs', source: 'wk', ...fast });
      s.write(line({ msg: 'x' }));
      await s.flush();
      await s.close();
    }
    const loki = JSON.parse(requests[0].body);
    expect(loki.streams[0].stream).toEqual({ app: 'wk' });
    expect(JSON.parse(loki.streams[0].values[0][1]).msg).toBe('x');
    expect(/^\d{19}$/.test(loki.streams[0].values[0][0])).toBe(true);
    const bulk = requests[1].body.trim().split('\n');
    expect(JSON.parse(bulk[0])).toEqual({ index: { _index: 'logs' } });
    expect(JSON.parse(bulk[1]).msg).toBe('x');
    const hec = JSON.parse(requests[2].body);
    expect(hec.source).toBe('wk');
    expect(hec.event.msg).toBe('x');
  });

  it('retries 5xx, drops on 400', async () => {
    const a = await receiver((_r, n) => (n < 3 ? 503 : 204));
    const s = createHttpSink({ url: a.url, ...fast });
    s.write(line());
    expect(await waitFor(() => s.stats().sent === 1, 3000)).toBe(true);
    expect(a.requests.length).toBe(3);
    await s.close();

    const b = await receiver(() => 400);
    const s2 = createHttpSink({ url: b.url, ...fast });
    s2.write(line());
    expect(await waitFor(() => s2.stats().dropped === 1)).toBe(true);
    expect(b.requests.length).toBe(1);
    await s2.close();
  });

  it('refuses an unknown format or a missing url', () => {
    expect(() => createHttpSink({ url: 'http://x', format: 'nope' })).toThrow(/unknown format/);
    expect(() => createHttpSink({})).toThrow(/url/);
  });
});

describe('log destination routing', () => {
  it('sends each line only to the sinks that accept its stream and level; a dead sink does not hurt the others', async () => {
    const dir = tmp();
    const dest = createLogDestination({
      sinks: [
        { type: 'file', path: path.join(dir, 'all.log') },
        { type: 'file', path: path.join(dir, 'audit.log'), streams: ['audit'] },
        { type: 'file', path: path.join(dir, 'errors.log'), minLevel: 'error' },
        { type: 'http', url: 'http://127.0.0.1:1/never', streams: ['app'] },
      ],
      buffer: { ...fast, maxLines: 100 },
      warn: quiet,
    });
    dest.write(line({ msg: 'app info' }));
    dest.write(line({ stream: 'audit', msg: 'audit event' }));
    dest.write(line({ level: 'error', msg: 'boom' }));
    await Promise.all(dest.stats().map(() => null));
    await dest.flush();
    const read = (f) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : '');
    expect(read('all.log').split('\n').filter(Boolean)).toHaveLength(3);
    expect(read('audit.log')).toContain('audit event');
    expect(read('audit.log')).not.toContain('app info');
    expect(read('errors.log')).toContain('boom');
    expect(read('errors.log')).not.toContain('app info');
    expect(dest.stats().find((s) => s.type === 'http').failures).toBeGreaterThan(0);
    await dest.close({ timeoutMs: 100 });
  });

  it('lines a full buffer would drop go to the local fallback file (0600)', async () => {
    const dir = tmp();
    const fb = path.join(dir, 'fallback.ndjson');
    const dest = createLogDestination({
      sinks: [{ type: 'http', url: 'http://127.0.0.1:1/never' }],
      buffer: { ...fast, maxLines: 100, flushIntervalMs: 60_000 },
      localFallback: { path: fb, maxBytes: 1_000_000 },
      warn: quiet,
    });
    for (let i = 0; i < 130; i++) dest.write(line({ msg: `m${i}` }));
    expect(await waitFor(() => dest.stats()[0].spilled > 0)).toBe(true);
    expect(readFileSync(fb, 'utf8')).toContain('"msg":"m0"');
    if (process.platform !== 'win32') expect(statSync(fb).mode & 0o777).toBe(0o600);
    await dest.close({ timeoutMs: 50 });
  });

  it('rejects an unknown sink type and an empty list', () => {
    expect(() => createLogDestination({ sinks: [{ type: 'carrier-pigeon' }] })).toThrow(/unknown type/);
    expect(() => createLogDestination({ sinks: [] })).toThrow(/at least one/);
  });
});

describe('audit mirror and `audit verify`', () => {
  function fakeLogger() {
    const lines = [];
    const make = (bind) => ({ child: (extra) => make({ ...bind, ...extra }), info: (msg, f) => lines.push({ ...bind, msg, ...f }) });
    return { logger: make({}), lines };
  }

  it('minimal mode ships id/hash/action only - no actor, ip or details; full ships the entry', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    const min = fakeLogger();
    const off1 = mirrorAuditToLogs(onEntry, min.logger, { mode: 'minimal' });
    const full = fakeLogger();
    const off2 = mirrorAuditToLogs(onEntry, full.logger, { mode: 'full' });
    auditLog(db, { actor: 'ivan', action: 'auth.login', ip: '10.0.0.5', meta: { username: 'ivan', password: 'x' } });
    off1();
    off2();
    expect(min.lines[0]).toMatchObject({ stream: 'audit', event: 'audit.entry', action: 'auth.login', id: 1 });
    expect(JSON.stringify(min.lines[0])).not.toContain('ivan');
    expect(JSON.stringify(min.lines[0])).not.toContain('10.0.0.5');
    expect(min.lines[0].hash).toHaveLength(64);
    expect(full.lines[0].actor.startsWith('~a:')).toBe(true); // pseudonym, not the login (F03)
    expect(JSON.stringify(full.lines[0])).not.toContain('ivan');
    expect(full.lines[0].hash).toBe(min.lines[0].hash);
    db.close();
  });

  it('the anchor line lets `audit verify` detect a truncated tail', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    for (let i = 0; i < 4; i++) auditLog(db, { action: `a${i}` });
    const { logger, lines } = fakeLogger();
    const a = logAuditAnchor(anchor, db, logger);
    expect(lines[0]).toMatchObject({ stream: 'audit', event: 'audit.anchor', anchorId: a.id, anchorHash: a.hash });
    expect(verifyChain(db, { anchor: a }).ok).toBe(true);
    db.exec('DROP TRIGGER IF EXISTS audit_log_no_delete');
    db.run('DELETE FROM audit_log WHERE id = ?', [4]);
    expect(verifyChain(db, { anchor: a }).ok).toBe(false);
    db.close();
  });

  it('CLI: audit verify / audit anchor exit codes', async () => {
    const out = [];
    const orig = [console.log, console.error];
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => out.push(a.join(' '));
    try {
      const cli = createCli();
      registerAuditCommands(cli, {
        db: {},
        tailFn: () => [],
        queryFn: () => [],
        verifyFn: (_db, o) => (o.anchor?.hash === 'good' || !o.anchor ? { ok: true, checked: 4 } : { ok: false, checked: 4, brokenAtId: 4, reason: 'anchored row is missing' }),
        anchorFn: () => ({ id: 4, hash: 'abc', count: 4, at: 'now' }),
      });
      expect(await cli.run(['audit', 'verify'])).toBe(0);
      expect(await cli.run(['audit', 'verify', '--anchor-id', '4', '--anchor-hash', 'good'])).toBe(0);
      expect(await cli.run(['audit', 'verify', '--anchor-id', '4', '--anchor-hash', 'bad'])).toBe(3);
      expect(await cli.run(['audit', 'verify', '--anchor-id', '4'])).toBe(2);
      expect(await cli.run(['audit', 'anchor'])).toBe(0);
      expect(out.join('\n')).toContain('anchor-id=4 anchor-hash=abc');
      expect(out.join('\n')).toContain('BROKEN at entry 4');
    } finally {
      [console.log, console.error] = orig;
    }
  });
});

describe('logging config', () => {
  const base = { appName: 'x', auth: { sessionSecret: 'a'.repeat(20) } };
  it('accepts the documented sinks and defaults the audit mirror to minimal', () => {
    const c = ApplicationConfigSchema.parse({
      ...base,
      logging: { sinks: [{ type: 'syslog', host: 'logs.example.com', protocol: 'tls' }, { type: 'http', url: 'https://loki.example.com/loki/api/v1/push', format: 'loki', headers: { Authorization: 'env:LOKI_TOKEN' } }] },
    });
    expect(c.logging.sinks).toHaveLength(2);
    expect(c.logging.auditMirror).toBe('minimal');
    expect(c.logging.buffer.maxLines).toBe(10000);
  });
  it('refuses plain http to a remote host, an unknown sink type and unknown keys', () => {
    expect(() => ApplicationConfigSchema.parse({ ...base, logging: { sinks: [{ type: 'http', url: 'http://logs.example.com/in' }] } })).toThrow();
    expect(() => ApplicationConfigSchema.parse({ ...base, logging: { sinks: [{ type: 'pigeon' }] } })).toThrow();
    expect(() => ApplicationConfigSchema.parse({ ...base, logging: { sinks: [{ type: 'file', path: 'x', bogus: 1 }] } })).toThrow();
    expect(ApplicationConfigSchema.parse({ ...base, logging: { sinks: [{ type: 'http', url: 'http://127.0.0.1:3100/in' }] } }).logging.sinks).toHaveLength(1);
  });
});

describe('compactLine (terminal view)', () => {
  it('shortens request and audit lines, leaves others alone', async () => {
    const { compactLine } = await import('../src/logs/logger.js');
    const req = compactLine(JSON.stringify({ level: 'info', time: 't', msg: 'request', req: { method: 'GET', path: '/admin' }, status: 401, responseTime: 15 }));
    expect(JSON.parse(req).msg).toBe('GET /admin 401 15ms');
    const aud = compactLine(JSON.stringify({ level: 'info', time: 't', stream: 'audit', action: 'auth.login', result: 'success', hash: 'x' }));
    expect(JSON.parse(aud).msg).toBe('audit auth.login success');
    const other = JSON.stringify({ level: 'info', msg: 'hello' });
    expect(compactLine(other)).toBe(other);
    expect(compactLine('not json')).toBe('not json');
  });
});
