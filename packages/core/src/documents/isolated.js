import { Worker } from 'node:worker_threads';
import { DocumentError } from './errors.js';

/**
 * `readDocument` in a worker thread of its own, for files from people you do not trust: own heap with a ceiling
 * (`maxMemoryMb`, 512; `RESOURCE_LIMIT`), a time limit (`timeoutMs`, 30 s; `TIMEOUT`), an empty environment, `signal`.
 * Options are those of `readDocument` that can be copied to another thread (no `zip`).
 */
export function readDocumentIsolated(buffer, { timeoutMs = 30_000, maxMemoryMb = 512, signal, ...opts } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('readDocumentIsolated: a Buffer is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new RangeError('readDocumentIsolated: timeoutMs must be a positive number');
  if (!Number.isFinite(maxMemoryMb) || maxMemoryMb < 16) throw new RangeError('readDocumentIsolated: maxMemoryMb must be at least 16');
  if (opts.zip) throw new TypeError('readDocumentIsolated: the archive reader cannot be passed to another thread');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let done = false;
    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: { buffer: new Uint8Array(buffer), opts },
      env: {}, stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
    });
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new DocumentError('TIMEOUT', 'reading the file took too long')), timeoutMs);
    const onAbort = () => finish(reject, signal.reason ?? new DOMException('aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (m) => (m.ok ? finish(resolve, m.result) : finish(reject, new DocumentError(m.code ?? 'WORKER_FAILED', m.message))));
    worker.on('error', (e) => finish(reject, e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new DocumentError('RESOURCE_LIMIT', 'reading the file needs more memory than allowed') : new DocumentError('WORKER_FAILED', String(e?.message ?? e))));
    worker.on('exit', (code) => finish(reject, new DocumentError(code === 0 ? 'WORKER_FAILED' : 'RESOURCE_LIMIT', 'the reader stopped before it finished')));
  });
}
