import { parentPort } from 'node:worker_threads';
// A worker for the pool tests: does what the payload says.
parentPort.on('message', ({ id, payload }) => {
  if (id === 0) return;
  if (payload.mode === 'hang') { for (;;) { /* stuck on purpose */ } }
  // JS heap (the worker's limit is for it), not Buffer memory
  if (payload.mode === 'alloc') { const keep = []; for (;;) keep.push(new Array(500_000).fill({ a: 1 })); }
  if (payload.mode === 'env') { parentPort.postMessage({ id, ok: true, result: Object.keys(process.env).length }); return; }
  if (payload.mode === 'fail') { parentPort.postMessage({ id, ok: false, code: 'MY_CODE', message: 'nope' }); return; }
  parentPort.postMessage({ id, ok: true, result: payload.value });
});
