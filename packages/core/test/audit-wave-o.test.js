import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { sanitizeSvg } from '../src/files/svg-sanitize.js';
import { assertUploadQuota, invalidateUploadUsage, noteUploadStored } from '../src/files/upload-quota.js';
import { createSseHandler, closeAllSseStreams } from '../src/realtime/sse-transport.js';
import { createEventBus } from '../src/realtime/event-bus.js';

describe('I08: SVG size cap before the DOM is built', () => {
  it('refuses an SVG over the limit with SVG_TOO_LARGE (default 1 MiB, configurable)', () => {
    let err;
    try { sanitizeSvg(`<svg>${'a'.repeat(2_000)}</svg>`, { maxBytes: 1_000 }); } catch (e) { err = e; }
    expect(err?.code).toBe('SVG_TOO_LARGE');
    let err2;
    try { sanitizeSvg(`<svg>${'a'.repeat(1_100_000)}</svg>`); } catch (e) { err2 = e; }
    expect(err2?.code).toBe('SVG_TOO_LARGE');
  });
});

describe('I09: upload usage is cached between scans', () => {
  const uuid = (n) => `${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;
  const put = (dir, n, size) => writeFileSync(path.join(dir, `${uuid(n)}.png`), Buffer.alloc(size));

  it('a rescan happens only after the TTL; cacheMs 0 scans every time; noteUploadStored keeps it honest', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'quota-'));
    invalidateUploadUsage(dir);
    put(dir, 1, 10);
    const q = { maxFiles: 2, cacheMs: 60_000 };
    assertUploadQuota(dir, q, 1); // scans: 1 file, room for one more
    put(dir, 2, 10); // another process writes meanwhile
    assertUploadQuota(dir, q, 1); // still the cached view (documented trade-off)
    invalidateUploadUsage(dir);
    let err;
    try { assertUploadQuota(dir, q, 1); } catch (e) { err = e; }
    expect(err?.code).toBe('QUOTA_EXCEEDED');

    const dir2 = mkdtempSync(path.join(os.tmpdir(), 'quota-'));
    invalidateUploadUsage(dir2);
    put(dir2, 1, 10);
    const exact = { maxFiles: 1, cacheMs: 0 };
    let err2;
    try { assertUploadQuota(dir2, exact, 1); } catch (e) { err2 = e; }
    expect(err2?.code).toBe('QUOTA_EXCEEDED');

    const dir3 = mkdtempSync(path.join(os.tmpdir(), 'quota-'));
    invalidateUploadUsage(dir3);
    const q3 = { maxFiles: 1, cacheMs: 60_000 };
    assertUploadQuota(dir3, q3, 1); // empty: fine, cached 0 files
    noteUploadStored(dir3, 1); // an upload really stored
    let err3;
    try { assertUploadQuota(dir3, q3, 1); } catch (e) { err3 = e; }
    expect(err3?.code).toBe('QUOTA_EXCEEDED');
  });
});

describe('I10: open SSE streams are re-authorized', () => {
  function mk() {
    const req = new EventEmitter();
    req.user = { id: 1 };
    req.headers = {};
    const res = new EventEmitter();
    res.chunks = [];
    res.writeHead = () => { res.opened = true; };
    res.write = (c) => res.chunks.push(c);
    res.flushHeaders = () => {};
    res.end = () => { res.ended = true; res.emit('close'); };
    res.status = (c) => { res.statusCode = c; return res; };
    res.set = () => res;
    res.json = () => res;
    return { req, res };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  it('closes the stream with an "unauthorized" event once reauthorize says no, and frees the slot', async () => {
    const bus = createEventBus();
    let alive = true;
    const handler = createSseHandler({ eventBus: bus, resolveChannel: () => 'c', heartbeatMs: 60_000, reauthorize: async () => alive, reauthorizeMs: 20 });
    const { req, res } = mk();
    await handler(req, res);
    expect(bus.subscriberCount('c')).toBe(1);
    await sleep(60);
    expect(res.ended).toBeUndefined(); // still allowed
    alive = false;
    await sleep(80);
    expect(res.ended).toBe(true);
    expect(res.chunks.join('')).toContain('event: unauthorized');
    expect(bus.subscriberCount('c')).toBe(0);
    closeAllSseStreams();
  });

  it('a throwing reauthorize counts as "no" (fail closed)', async () => {
    const bus = createEventBus();
    const handler = createSseHandler({ eventBus: bus, resolveChannel: () => 'c', heartbeatMs: 60_000, reauthorize: async () => { throw new Error('db down'); }, reauthorizeMs: 20 });
    const { req, res } = mk();
    await handler(req, res);
    await sleep(80);
    expect(res.ended).toBe(true);
    closeAllSseStreams();
  });
});
