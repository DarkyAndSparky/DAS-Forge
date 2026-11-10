import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import { createCors } from '../src/http/cors.js';

let server;
afterEach(() => new Promise((resolve) => (server ? server.close(resolve) : resolve())));

async function boot(opts) {
  const app = express();
  app.use(createCors(opts));
  app.get('/x', (_req, res) => res.json({ ok: true }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function call(port, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/x', method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('createCors', () => {
  it('empty list: no CORS headers, even for an Origin header', async () => {
    const port = await boot({ origins: [] });
    const r = await call(port, { headers: { Origin: 'https://evil.example' } });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('allowed origin is echoed with credentials and Vary: Origin', async () => {
    const port = await boot({ origins: ['https://app.example.com'] });
    const r = await call(port, { headers: { Origin: 'https://app.example.com' } });
    expect(r.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(r.headers['access-control-allow-credentials']).toBe('true');
    expect(r.headers.vary).toMatch(/Origin/i);
  });

  it('trailing slash in config is normalised; matching is exact (port, scheme, subdomain)', async () => {
    const port = await boot({ origins: ['https://app.example.com/'] });
    for (const bad of ['http://app.example.com', 'https://app.example.com:8443', 'https://x.app.example.com', 'https://app.example.com.evil.io']) {
      const r = await call(port, { headers: { Origin: bad } });
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    }
    const ok = await call(port, { headers: { Origin: 'https://app.example.com' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example.com');
  });

  it('unlisted origin and Origin: null get no CORS headers', async () => {
    const port = await boot({ origins: ['https://app.example.com', 'null'] });
    for (const o of ['https://evil.example', 'null']) {
      const r = await call(port, { headers: { Origin: o } });
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('same-origin request (no Origin header) is untouched', async () => {
    const port = await boot({ origins: ['https://app.example.com'] });
    const r = await call(port);
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('preflight from an allowed origin: 204 with methods, headers and max-age', async () => {
    const port = await boot({ origins: ['https://app.example.com'], maxAgeSec: 120 });
    const r = await call(port, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(r.headers['access-control-allow-methods']).toMatch(/POST/);
    expect(r.headers['access-control-allow-headers']).toMatch(/Content-Type/i);
    expect(r.headers['access-control-max-age']).toBe('120');
  });

  it('preflight from an unlisted origin carries no allow headers', async () => {
    const port = await boot({ origins: ['https://app.example.com'] });
    const r = await call(port, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['access-control-allow-methods']).toBeUndefined();
  });

  it('refuses wildcards and malformed origins at construction', () => {
    expect(() => createCors({ origins: ['*'] })).toThrow(/wildcard/);
    expect(() => createCors({ origins: ['https://*.example.com'] })).toThrow(/wildcard/);
    expect(() => createCors({ origins: ['not a url'] })).toThrow(/not a valid origin/);
    expect(() => createCors({ origins: ['ftp://files.example.com'] })).toThrow(/http or https/);
  });
});
