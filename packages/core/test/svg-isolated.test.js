import { describe, it, expect, afterAll } from 'vitest';
import { createWorkerPool } from '../src/files/isolated-pool.js';
import { sanitizeSvgIsolated, closeSvgPool, checkSvgShape } from '../src/files/svg-isolated.js';
import { validateUpload } from '../src/files/validate-upload.js';

const FIXTURE = new URL('./pool-fixture-worker.js', import.meta.url);
const OK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect onload="x()" width="5" height="5"/></svg>';

describe('worker pool', () => {
  it('runs jobs, passes error codes through and keeps the worker for the next job', async () => {
    const pool = createWorkerPool({ workerUrl: FIXTURE, size: 1 });
    expect(await pool.run({ value: 41 })).toBe(41);
    await expect(pool.run({ mode: 'fail' })).rejects.toMatchObject({ code: 'MY_CODE' });
    expect(await pool.run({ value: 'again' })).toBe('again');
    await pool.close();
  });
  it('the worker sees an empty environment', async () => {
    process.env.DAS_TEST_SECRET = 'top-secret';
    const pool = createWorkerPool({ workerUrl: FIXTURE, size: 1 });
    expect(await pool.run({ mode: 'env' })).toBe(0);
    await pool.close();
    delete process.env.DAS_TEST_SECRET;
  });
  it('stops a job stuck in a loop at the time limit and serves the next job with a fresh worker', async () => {
    const pool = createWorkerPool({ workerUrl: FIXTURE, size: 1, timeoutMs: 300 });
    const t0 = Date.now();
    await expect(pool.run({ mode: 'hang' })).rejects.toMatchObject({ code: 'POOL_TIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await pool.run({ value: 7 })).toBe(7);
    await pool.close();
  });
  it('a job that needs too much memory kills its worker, not the server', async () => {
    const pool = createWorkerPool({ workerUrl: FIXTURE, size: 1, maxMemoryMb: 32, timeoutMs: 20_000 });
    await expect(pool.run({ mode: 'alloc' })).rejects.toMatchObject({ code: expect.stringMatching(/^POOL_(RESOURCE_LIMIT|WORKER_FAILED)$/) });
    expect(await pool.run({ value: 1 })).toBe(1);
    await pool.close();
  });
  it('refuses at once when the workers are busy and the queue is full', async () => {
    const pool = createWorkerPool({ workerUrl: FIXTURE, size: 1, queueLimit: 1, timeoutMs: 400 });
    const a = pool.run({ mode: 'hang' }).catch((e) => e.code);
    const b = pool.run({ value: 'queued' });
    await expect(pool.run({ value: 'too many' })).rejects.toMatchObject({ code: 'POOL_BUSY' });
    expect(await a).toBe('POOL_TIMEOUT');
    expect(await b).toBe('queued');
    await pool.close();
  });
  it('checks its options', () => {
    expect(() => createWorkerPool({ workerUrl: 'x' })).toThrow();
    expect(() => createWorkerPool({ workerUrl: FIXTURE, size: 0 })).toThrow();
  });
});

describe('SVG sanitizing in a worker (audit S-01)', () => {
  afterAll(() => closeSvgPool());

  it('gives the same clean result as before: script and handlers are gone', async () => {
    const clean = await sanitizeSvgIsolated(OK_SVG);
    expect(clean).toContain('<svg');
    expect(clean).not.toMatch(/script|onload|alert/i);
  });
  it('refuses a huge nesting in linear time, before any DOM is built', async () => {
    const bomb = `<svg xmlns="http://www.w3.org/2000/svg">${'<g>'.repeat(30_000)}${'</g>'.repeat(30_000)}</svg>`;
    const t0 = Date.now();
    await expect(sanitizeSvgIsolated(bomb, { maxBytes: 0 })).rejects.toMatchObject({ code: 'SVG_TOO_COMPLEX' });
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it('refuses a huge number of attributes and of elements', () => {
    expect(() => checkSvgShape(`<svg><rect ${Array.from({ length: 12_000 }, (_, i) => `a${i}="1"`).join(' ')}/></svg>`)).toThrow(expect.objectContaining({ code: 'SVG_TOO_COMPLEX' }));
    expect(() => checkSvgShape(`<svg>${'<rect/>'.repeat(6_000)}</svg>`)).toThrow(expect.objectContaining({ code: 'SVG_TOO_COMPLEX' }));
    expect(() => checkSvgShape('<svg><g><g><rect width="1"/></g></g></svg>')).not.toThrow();
  });
  it('refuses a big file and entity declarations', async () => {
    await expect(sanitizeSvgIsolated(`<svg>${' '.repeat(300_000)}</svg>`)).rejects.toMatchObject({ code: 'SVG_TOO_LARGE' });
    await expect(sanitizeSvgIsolated('<!DOCTYPE svg [<!ENTITY a "b">]><svg/>')).rejects.toMatchObject({ code: 'SVG_REJECTED' });
  });
  it('the event loop keeps running while a worker sanitizes', async () => {
    let ticks = 0; const iv = setInterval(() => { ticks += 1; }, 5);
    const parts = Array.from({ length: 4 }, () => sanitizeSvgIsolated(OK_SVG));
    await Promise.all(parts);
    clearInterval(iv);
    expect(ticks).toBeGreaterThan(0);
  });
  it('an upload of an SVG goes through the worker and comes back sanitized', async () => {
    const out = await validateUpload(Buffer.from(OK_SVG), { allowedTypes: ['svg'] });
    expect(out.type).toBe('svg');
    expect(out.buffer.toString()).not.toMatch(/script|onload/i);
    await expect(validateUpload(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${'<g>'.repeat(500)}</svg>`), { allowedTypes: ['svg'] })).rejects.toMatchObject({ code: 'SVG_TOO_COMPLEX' });
  });
});
