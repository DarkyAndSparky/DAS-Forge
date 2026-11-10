import { Worker } from 'node:worker_threads';
import { XlsxError } from './errors.js';

/**
 * `readSpreadsheet` in a worker thread of its own, for files from people you do not trust. What it adds:
 * - memory: the worker gets its own heap with a ceiling (`maxMemoryMb`, 512 by default); a file that needs more kills
 *   the worker, not your server (`RESOURCE_LIMIT`);
 * - time: after `timeoutMs` (30 s by default) the worker is stopped even if it is stuck in a loop (`TIMEOUT`);
 * - the worker sees an empty environment (none of your secrets) and has nothing but the file and the options;
 * - `signal` stops the read at once.
 * Takes the options of `readSpreadsheet` that can be copied to another thread (not `zip` or `signal` functions);
 * returns the same result, `format` included. Errors are `XlsxError`s with the same codes as the plain reader.
 *
 * @param {Buffer} buffer
 * @param {{timeoutMs?: number, maxMemoryMb?: number, signal?: AbortSignal, zipModule?: string} & Record<string, any>} [options]
 */
export function readSpreadsheetIsolated(buffer, { timeoutMs = 30_000, maxMemoryMb = 512, signal, zipModule, ...opts } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('readSpreadsheetIsolated: a Buffer is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new RangeError('readSpreadsheetIsolated: timeoutMs must be a positive number');
  if (!Number.isFinite(maxMemoryMb) || maxMemoryMb < 16) throw new RangeError('readSpreadsheetIsolated: maxMemoryMb must be at least 16');
  if (typeof opts.zip === 'function' || opts.zip) throw new TypeError('readSpreadsheetIsolated: the archive reader cannot be passed to another thread');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let done = false;
    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: { buffer: new Uint8Array(buffer), opts, zipModule },
      env: {}, // the worker must not see this process's secrets
      stdout: true, stderr: true, // its output is not the server's
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
    const timer = setTimeout(() => finish(reject, new XlsxError('TIMEOUT', 'reading the file took too long')), timeoutMs);
    const onAbort = () => finish(reject, signal.reason ?? new DOMException('aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (m) => {
      if (m.ok) finish(resolve, m.result);
      else finish(reject, new XlsxError(m.xlsx && m.code ? m.code : 'WORKER_FAILED', m.message));
    });
    worker.on('error', (e) => finish(reject, e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new XlsxError('RESOURCE_LIMIT', 'reading the file needs more memory than allowed') : new XlsxError('WORKER_FAILED', String(e?.message ?? e))));
    worker.on('exit', (code) => finish(reject, new XlsxError(code === 0 ? 'WORKER_FAILED' : 'RESOURCE_LIMIT', 'the reader stopped before it finished')));
  });
}
