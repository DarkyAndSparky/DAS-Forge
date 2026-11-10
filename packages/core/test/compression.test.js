import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import zlib from 'node:zlib';
import { createCompression } from '../src/http/compression.js';

let server;
afterEach(() => new Promise((r) => (server ? server.close(r) : r())));

async function boot(handler, opts) {
  const mw = createCompression(opts);
  server = http.createServer((req, res) => mw(req, res, () => handler(req, res)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}

function get(port, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/', headers: { 'accept-encoding': 'gzip', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

const BIG = JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ id: i, name: 'item-' + i })) });

describe('createCompression', () => {
  it('compresses a large JSON body', async () => {
    const port = await boot((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(BIG);
    });
    const r = await get(port);
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(zlib.gunzipSync(r.body).toString()).toBe(BIG);
  });

  it('leaves small bodies alone (threshold)', async () => {
    const port = await boot((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    });
    expect((await get(port)).headers['content-encoding']).toBeUndefined();
  });

  it('never compresses text/event-stream, whether set via setHeader or writeHead', async () => {
    const viaSet = await boot((req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end('data: ' + 'x'.repeat(3000) + '\n\n');
    });
    expect((await get(viaSet)).headers['content-encoding']).toBeUndefined();
    await new Promise((r) => server.close(r));

    const viaHead = await boot((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + 'x'.repeat(3000) + '\n\n');
    });
    expect((await get(viaHead)).headers['content-encoding']).toBeUndefined();
  });

  it('an Accept: text/event-stream request is not compressed even before the type is known', async () => {
    const port = await boot((req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.end('y'.repeat(3000));
    });
    expect((await get(port, { accept: 'text/event-stream' })).headers['content-encoding']).toBeUndefined();
  });

  it('X-No-Compression opts a response out', async () => {
    const port = await boot((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-No-Compression', '1');
      res.end(BIG);
    });
    expect((await get(port)).headers['content-encoding']).toBeUndefined();
  });

  it('already-compressed types (images) are not touched', async () => {
    const port = await boot((req, res) => {
      res.setHeader('Content-Type', 'image/png');
      res.end(Buffer.alloc(4000, 1));
    });
    expect((await get(port)).headers['content-encoding']).toBeUndefined();
  });
});
