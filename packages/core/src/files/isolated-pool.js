import { Worker } from 'node:worker_threads';

/**
 * A small pool of long-lived worker threads for untrusted-input work (file readers and sanitizers). What it gives:
 * - the work does not block the server: the main thread only sends a job and waits;
 * - time: a job that runs longer than `timeoutMs` is stopped even if the worker is stuck in a loop (`POOL_TIMEOUT`),
 *   and the worker is replaced by a fresh one (nothing a hostile input left behind is reused);
 * - memory: every worker has its own heap with a ceiling (`maxMemoryMb`); a job that needs more kills the worker,
 *   not the server (`POOL_RESOURCE_LIMIT`);
 * - a worker sees an empty environment (none of the server's secrets) and only the data of its job;
 * - load: at most `size` jobs run at once and at most `queueLimit` wait; more are refused at once (`POOL_BUSY`)
 *   instead of piling up in memory.
 * Workers start on the first job (and are warm for the next ones: loading a heavy library is paid once) and do not keep
 * the process alive. The worker file reads `{id, payload}` from `parentPort` and answers `{id, ok: true, result}` or
 * `{id, ok: false, code, message}`. Only copyable data crosses the border (strings, buffers, plain objects).
 *
 * @param {{workerUrl: URL, size?: number, queueLimit?: number, timeoutMs?: number, maxMemoryMb?: number, warmup?: any}} o
 * @returns {{run: (payload: any, o?: {timeoutMs?: number, transfer?: ArrayBuffer[]}) => Promise<any>, close: () => Promise<void>, stats: () => {workers: number, busy: number, queued: number}}}
 */
export function createWorkerPool({ workerUrl, size = 2, queueLimit = 16, timeoutMs = 10_000, maxMemoryMb = 256, warmup } = {}) {
  if (!(workerUrl instanceof URL)) throw new TypeError('createWorkerPool: workerUrl must be a URL');
  if (!Number.isInteger(size) || size < 1 || size > 16) throw new RangeError('createWorkerPool: size must be 1..16');
  if (!Number.isInteger(queueLimit) || queueLimit < 0) throw new RangeError('createWorkerPool: queueLimit must be 0 or more');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new RangeError('createWorkerPool: timeoutMs must be positive');
  if (!Number.isFinite(maxMemoryMb) || maxMemoryMb < 16) throw new RangeError('createWorkerPool: maxMemoryMb must be at least 16');

  const slots = []; // {worker, job}
  const queue = [];
  let nextId = 1;
  let closed = false;
  const fail = (code, message) => Object.assign(new Error(message), { code });

  function spawn() {
    const worker = new Worker(workerUrl, {
      env: {},
      stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
    });
    worker.unref();
    const slot = { worker, job: null, dead: false };
    worker.on('message', (m) => {
      const job = slot.job;
      if (!job || m?.id !== job.id) return;
      finishJob(slot, m.ok ? null : fail(m.code ?? 'POOL_WORKER_FAILED', String(m.message ?? 'the worker failed')), m.result);
    });
    worker.on('error', (e) => retire(slot, e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? fail('POOL_RESOURCE_LIMIT', 'the job needs more memory than allowed') : fail('POOL_WORKER_FAILED', 'the worker failed')));
    worker.on('exit', () => retire(slot, fail('POOL_WORKER_FAILED', 'the worker stopped before it finished')));
    if (warmup !== undefined) worker.postMessage({ id: 0, payload: warmup });
    slots.push(slot);
    return slot;
  }

  /** The job is over (answer, timeout or crash): answer its caller and take the next one from the queue. */
  function finishJob(slot, err, result) {
    const job = slot.job;
    slot.job = null;
    if (!job) return;
    clearTimeout(job.timer);
    if (err) job.reject(err); else job.resolve(result);
    pump();
  }

  /** The worker is gone or must go: drop it; its job (if any) fails with `err`. */
  function retire(slot, err) {
    if (slot.dead) return;
    slot.dead = true;
    const i = slots.indexOf(slot);
    if (i !== -1) slots.splice(i, 1);
    slot.worker.terminate().catch(() => {});
    finishJob(slot, err);
    pump();
  }

  function pump() {
    while (queue.length > 0) {
      let slot = slots.find((s) => !s.job && !s.dead);
      if (!slot && slots.length < size && !closed) slot = spawn();
      if (!slot) return;
      const job = queue.shift();
      slot.job = job;
      job.timer = setTimeout(() => retire(slot, fail('POOL_TIMEOUT', 'the job took too long')), job.timeoutMs);
      job.timer.unref?.();
      try { slot.worker.postMessage({ id: job.id, payload: job.payload }, job.transfer ?? []); } catch (e) { retire(slot, fail('POOL_WORKER_FAILED', String(e?.message ?? e))); }
    }
  }

  return {
    run(payload, { timeoutMs: t = timeoutMs, transfer } = {}) {
      if (closed) return Promise.reject(fail('POOL_CLOSED', 'the pool is closed'));
      const busyNow = slots.filter((s) => s.job).length;
      if (busyNow >= size && queue.length >= queueLimit) return Promise.reject(fail('POOL_BUSY', 'too many jobs at once, try again later'));
      return new Promise((resolve, reject) => {
        queue.push({ id: nextId++, payload, transfer, timeoutMs: t, resolve, reject, timer: null });
        pump();
      });
    },
    async close() {
      closed = true;
      while (queue.length) queue.shift().reject(fail('POOL_CLOSED', 'the pool is closed'));
      await Promise.all(slots.splice(0).map((s) => { clearTimeout(s.job?.timer); s.job?.reject(fail('POOL_CLOSED', 'the pool is closed')); return s.worker.terminate().catch(() => {}); }));
    },
    stats: () => ({ workers: slots.length, busy: slots.filter((s) => s.job).length, queued: queue.length }),
  };
}
