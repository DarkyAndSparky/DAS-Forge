import { describe, it, expect } from 'vitest';
import { configureImageConcurrency, imageConcurrencyStats, withImageSlot, ImageBusyError } from '../src/files/image-pipeline.js';
import { UploadsConfigSchema } from '../src/config/schema.js';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

describe('image processing concurrency (I07)', () => {
  it('runs at most maxConcurrent at once, queues the next, refuses beyond maxQueue with 503', async () => {
    configureImageConcurrency({ maxConcurrent: 2, maxQueue: 1 });
    const gates = [deferred(), deferred(), deferred()];
    let running = 0; let peak = 0;
    const task = (g) => () => withImageSlot(async () => { running++; peak = Math.max(peak, running); await g.promise; running--; return 'ok'; });
    const p1 = task(gates[0])(); const p2 = task(gates[1])(); const p3 = task(gates[2])();
    await new Promise((r) => setImmediate(r));
    expect(imageConcurrencyStats()).toMatchObject({ active: 2, waiting: 1 });
    let err;
    try { await withImageSlot(async () => 'x'); } catch (e) { err = e; }
    expect(err instanceof ImageBusyError).toBe(true);
    expect(err.status).toBe(503);
    expect(err.code).toBe('IMAGE_BUSY');
    gates.forEach((g) => g.resolve());
    expect(await Promise.all([p1, p2, p3])).toEqual(['ok', 'ok', 'ok']);
    expect(peak).toBe(2);
    expect(imageConcurrencyStats()).toMatchObject({ active: 0, waiting: 0 });
  });

  it('a failing task releases its slot', async () => {
    configureImageConcurrency({ maxConcurrent: 1, maxQueue: 0 });
    await expect(withImageSlot(async () => { throw new Error('boom'); })).rejects.toThrow(/boom/);
    expect(await withImageSlot(async () => 'fine')).toBe('fine');
  });

  it('uploads config has defaults and bounds', () => {
    expect(UploadsConfigSchema.parse({}).imageProcessing).toEqual({ maxConcurrent: 2, maxQueue: 16 });
    expect(UploadsConfigSchema.safeParse({ imageProcessing: { maxConcurrent: 0 } }).success).toBe(false);
  });
});
