/**
 * Worker thread: makes a consistent snapshot of a database FILE with `VACUUM INTO` and runs `PRAGMA integrity_check`
 * on the copy, on its own connection - so the long, synchronous work does not stop the main thread's event loop
 * (audit I03). Started by `adapter.snapshotToAsync`.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

try {
  const { file, dest, busyTimeoutMs = 5000, check = true } = workerData;
  const src = new DatabaseSync(file, { readOnly: true });
  try {
    src.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0}`);
    src.prepare('VACUUM INTO ?').run(String(dest));
  } finally {
    src.close();
  }
  let integrityOk = null;
  if (check) {
    const copy = new DatabaseSync(dest, { readOnly: true });
    try {
      const rows = copy.prepare('PRAGMA integrity_check').all();
      integrityOk = rows.length === 1 && Object.values(rows[0])[0] === 'ok';
    } finally {
      copy.close();
    }
  }
  parentPort.postMessage({ ok: true, integrityOk });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err?.message ?? err) });
}
