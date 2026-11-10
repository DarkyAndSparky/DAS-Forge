// Runs in a worker thread (see isolated.js): reads one file and posts back the result or the error. Nothing else.
import { parentPort, workerData } from 'node:worker_threads';
import { readSpreadsheet } from './read-any.js';

const { buffer, opts, zipModule } = workerData;
try {
  const zip = zipModule ? (await import(zipModule)).zip : undefined; // a stand-in archive reader, for tests only
  const result = await readSpreadsheet(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength), { ...opts, ...(zip ? { zip } : {}) });
  parentPort.postMessage({ ok: true, result });
} catch (e) {
  parentPort.postMessage({ ok: false, xlsx: e?.name === 'XlsxError', code: e?.code ?? null, message: String(e?.message ?? e) });
}
