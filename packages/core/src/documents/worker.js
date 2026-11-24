// Runs in a worker thread (see isolated.js): reads one document and posts back the result or the error. Nothing else.
import { parentPort, workerData } from 'node:worker_threads';
import { readDocument } from './read.js';

const { buffer, opts } = workerData;
try {
  // Plug-in readers are named by module (a function cannot cross to this thread): `{ readerModules: { pdf: '@das-forge/documents-pdf' } }`.
  const { readerModules, ...rest } = opts;
  const readers = {};
  for (const [kind, spec] of Object.entries(readerModules ?? {})) readers[kind] = (await import(spec)).default;
  const result = await readDocument(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength), { ...rest, readers });
  parentPort.postMessage({ ok: true, result });
} catch (e) {
  parentPort.postMessage({ ok: false, code: e?.name === 'DocumentError' ? e.code : null, message: String(e?.message ?? e) });
}
