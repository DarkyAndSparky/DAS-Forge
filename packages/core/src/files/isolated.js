import { createWorkerPool } from './isolated-pool.js';
import { ImageBusyError } from './image-pipeline.js';
import { CsvError } from '../csv/index.js';
import { closeSvgPool } from './svg-isolated.js';

/**
 * Readers of untrusted files in worker threads (a shared pool): a stuck or memory-hungry file stops its own worker, not
 * the server; the raw file stays in the worker and only the checked result comes back. Same results and error codes as
 * the plain functions (`reencodeImage`, `checkZipSafety`, `verifyZipData`, `parseCsv`); extra codes `POOL_TIMEOUT`,
 * `POOL_BUSY` (an image: `IMAGE_BUSY`, answer 503), `POOL_RESOURCE_LIMIT`, `POOL_WORKER_FAILED`.
 */
let pool = null;
let settings = { size: 2, queueLimit: 16, timeoutMs: 30_000, maxMemoryMb: 1024 };

/** Sets the pool before its first use (later calls change nothing until `closeWorkers()`). */
export function configureFileWorkers(o = {}) { settings = { ...settings, ...o }; }

const getPool = () => (pool ??= createWorkerPool({ workerUrl: new URL('./file-worker.js', import.meta.url), warmup: {}, ...settings }));
const run = (task, args) => getPool().run({ task, args });

/** Stops all worker pools of the files module (a test, a graceful shutdown); the next call creates new ones. */
export async function closeWorkers() {
  const p = pool; pool = null;
  await Promise.all([p?.close(), closeSvgPool()]);
}

/** `reencodeImage` in a worker. The `heif` option (a module) cannot cross to another thread. */
export async function reencodeImageIsolated(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('reencodeImageIsolated: a Buffer is required');
  if (options.heif) throw new TypeError('reencodeImageIsolated: the heif option cannot be passed to another thread');
  try {
    const r = await run('image.reencode', { buffer, options });
    return { ...r, buffer: Buffer.from(r.buffer) };
  } catch (e) {
    if (e?.code === 'POOL_BUSY') throw new ImageBusyError();
    throw e;
  }
}

/** `checkZipSafety` in a worker. */
export const checkZipSafetyIsolated = (buffer, options = {}) => run('zip.guard', { buffer, options });

/** `verifyZipData` in a worker. */
export const verifyZipDataIsolated = (buffer, options = {}) => run('zip.verify', { buffer, options });

/** `parseCsv` in a worker; errors are `CsvError`s with the same codes. */
export async function parseCsvIsolated(input, options = {}) {
  try {
    return await run('csv.parse', { input, options });
  } catch (e) {
    if (/^(TOO_BIG|TOO_MANY_COLS|TOO_MANY_CELLS|TOO_MANY_ROWS|UNTERMINATED_QUOTE)$/.test(e?.code ?? '')) throw new CsvError(e.code, e.message);
    throw e;
  }
}
