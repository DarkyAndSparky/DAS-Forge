import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { createHttpRedirectServer, resolveRedirectPort, listenServer } from '../src/http/server.js';

describe('resolveRedirectPort', () => {
  it('is port - 1 when this process terminates TLS', () => {
    expect(resolveRedirectPort({ port: 9002, https: { mode: 'self-signed' } })).toBe(9001);
    expect(resolveRedirectPort({ port: 9102, https: { mode: 'standalone' } })).toBe(9101);
  });
  it('is off behind a reverse proxy, explicit values win, false disables', () => {
    expect(resolveRedirectPort({ port: 9002, https: { mode: 'reverse-proxy' } })).toBe(false);
    expect(resolveRedirectPort({ port: 9002, httpRedirectPort: 80 })).toBe(80);
    expect(resolveRedirectPort({ port: 9002, httpRedirectPort: false })).toBe(false);
    expect(resolveRedirectPort({ port: 1 })).toBe(false);
  });
});

describe('createHttpRedirectServer', () => {
  async function ask(opts, { method = 'GET', path = '/', host } = {}) {
    const server = createHttpRedirectServer(opts);
    const { port } = await listenServer(server, { host: '127.0.0.1', port: 0 });
    try {
      return await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path, headers: host ? { host } : {} }, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
        });
        req.on('error', reject);
        req.end();
      });
    } finally {
      server.close();
      server.closeAllConnections?.();
    }
  }

  it('answers 308 to the same path on https and the https port for GET and HEAD', async () => {
    const get = await ask({ httpsPort: 9002 }, { path: '/admin?x=1', host: 'localhost:9001' });
    expect(get).toEqual({ status: 308, location: 'https://localhost:9002/admin?x=1' });
    expect((await ask({ httpsPort: 9002 }, { method: 'HEAD', path: '/', host: 'localhost' })).status).toBe(308);
  });

  it('refuses (426, no redirect) a request that carries a body over plain HTTP, unless told otherwise (item 2)', async () => {
    const post = await ask({ httpsPort: 9002 }, { method: 'POST', path: '/login', host: 'localhost:9001' });
    expect(post.status).toBe(426);
    expect(post.location).toBeUndefined();
    expect((await ask({ httpsPort: 9002 }, { method: 'DELETE', path: '/x', host: 'localhost' })).status).toBe(426);
    const lenient = await ask({ httpsPort: 9002, redirectUnsafeMethods: true }, { method: 'POST', path: '/login', host: 'localhost' });
    expect(lenient).toEqual({ status: 308, location: 'https://localhost:9002/login' });
  });

  it('trusts the Host header only for allowed hosts (no open redirect)', async () => {
    const opts = { httpsPort: 9002, canonicalHost: 'app.example', allowedHosts: ['alt.example'] };
    expect((await ask(opts, { host: 'alt.example:9001' })).location).toBe('https://alt.example:9002/');
    expect((await ask(opts, { host: 'evil.example' })).location).toBe('https://app.example:9002/');
  });

  it('omits the port for 443', async () => {
    expect((await ask({ httpsPort: 443 }, { host: 'localhost' })).location).toBe('https://localhost/');
  });

  it('reports hand-typed http hits at most once per address per interval, never the query string', async () => {
    const hits = [];
    const server = createHttpRedirectServer({ httpsPort: 9002, onRedirect: (i) => hits.push(i), notifyEveryMs: 60_000 });
    const { port } = await listenServer(server, { host: '127.0.0.1', port: 0 });
    const get = (path) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path, headers: { host: 'localhost' } }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
    });
    try {
      await get('/a?token=SECRET');
      await get('/b');
      await get('/c');
    } finally {
      server.close();
      server.closeAllConnections?.();
    }
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ method: 'GET', path: '/a', count: 1 });
    expect(JSON.stringify(hits[0])).not.toContain('SECRET');
  });

  it('survives a throwing callback', async () => {
    const r = await ask({ httpsPort: 9002, onRedirect: () => { throw new Error('boom'); } }, { host: 'localhost' });
    expect(r.status).toBe(308);
  });
});
