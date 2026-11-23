// Runs in a worker thread (see isolated.js): reads one document and posts back the result or the error. Nothing else.
import { parentPort, workerData } from 'node:worker_threads';
import { readDocument } from './read.js';

const { buffer, opts } = workerData;
try {
  const result = await readDocument(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength), opts);
  parentPort.postMessage({ ok: true, result });
} catch (e) {
  parentPort.postMessage({ ok: false, code: e?.name === 'DocumentError' ? e.code : null, message: String(e?.message ?? e) });
}
