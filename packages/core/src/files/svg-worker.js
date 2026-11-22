import { parentPort } from 'node:worker_threads';
import { sanitizeSvg } from './svg-sanitize.js';

// The worker of the SVG pool: sanitizes one text and answers with the clean text. It has no other job.
// The first message (id 0, from the pool) only loads jsdom so that the first real upload does not pay for it.
parentPort.on('message', ({ id, payload }) => {
  try {
    if (id === 0) { sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"/>'); return; }
    const clean = sanitizeSvg(payload.text, { maxBytes: payload.maxBytes });
    parentPort.postMessage({ id, ok: true, result: clean });
  } catch (e) {
    if (id === 0) return;
    parentPort.postMessage({ id, ok: false, code: e?.code ?? 'SVG_REJECTED', message: e?.message ?? 'rejected' });
  }
});
