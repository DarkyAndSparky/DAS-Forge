import { parentPort } from 'node:worker_threads';

// The worker of the file pool: runs one named task over data it was given and answers with plain data. The raw
// (untrusted) file never leaves this thread except as the verified result. Heavy libraries load on first use.
const tasks = {
  async 'image.reencode'({ buffer, options }) {
    const { reencodeImage } = await import('./image-pipeline.js');
    const r = await reencodeImage(Buffer.from(buffer), options);
    return { buffer: new Uint8Array(r.buffer), format: r.format, width: r.width, height: r.height };
  },
  async 'zip.guard'({ buffer, options }) {
    const { checkZipSafety } = await import('./zip-guard.js');
    return checkZipSafety(Buffer.from(buffer), options);
  },
  async 'zip.verify'({ buffer, options }) {
    const { verifyZipData } = await import('./zip-verify.js');
    return verifyZipData(Buffer.from(buffer), options);
  },
  async 'csv.parse'({ input, options }) {
    const { parseCsv } = await import('../csv/index.js');
    return parseCsv(typeof input === 'string' ? input : new Uint8Array(input), options);
  },
};

parentPort.on('message', async ({ id, payload }) => {
  if (id === 0) return;
  try {
    const fn = Object.hasOwn(tasks, payload?.task) ? tasks[payload.task] : null;
    if (!fn) throw Object.assign(new Error('unknown task'), { code: 'POOL_UNKNOWN_TASK' });
    const result = await fn(payload.args);
    const transfer = result?.buffer instanceof Uint8Array ? [result.buffer.buffer] : [];
    parentPort.postMessage({ id, ok: true, result }, transfer);
  } catch (e) {
    parentPort.postMessage({ id, ok: false, code: e?.code ?? 'POOL_TASK_FAILED', message: String(e?.message ?? e).slice(0, 500) });
  }
});
