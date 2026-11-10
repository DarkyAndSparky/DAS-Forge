import { readFileSync, statSync } from 'node:fs';
import tls from 'node:tls';

/**
 * Hot certificate reload (audit R-04): after `cert renew` (or an external renewal) the running process starts serving the new
 * certificate without a restart. A new pair is checked first (`tls.createSecureContext` refuses a key that does not match the
 * certificate); a bad pair is reported and the old one keeps serving. Triggers: SIGHUP (not on Windows) and a poll of the files'
 * modification time (works everywhere, also for `cert renew` run from another terminal).
 *
 * @param {object} o
 * @param {string} o.certPath
 * @param {string} o.keyPath
 * @param {() => Array<{setSecureContext?: Function}>} o.servers - the listening servers (re-read at every reload)
 * @param {(event: {ok: boolean, reason?: string}) => void} [o.onReload] - for the log and the audit
 * @param {number} [o.pollMs=60000] - 0 = no polling
 * @param {boolean} [o.sighup=true]
 */
export function createTlsReloader({ certPath, keyPath, servers, onReload = () => {}, pollMs = 60_000, sighup = true } = {}) {
  if (!certPath || !keyPath || typeof servers !== 'function') throw new TypeError('createTlsReloader: certPath, keyPath and servers() are required');
  const stamp = () => { try { return `${statSync(certPath).mtimeMs}:${statSync(keyPath).mtimeMs}`; } catch { return null; } };
  let seen = stamp();
  let failedAt = null; // stamp of the last pair that was refused: tried again only when the files change again (a pair is written in two steps)
  let timer = null;
  let onHup = null;

  function reload() {
    let pair;
    try {
      pair = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
      tls.createSecureContext(pair); // throws when the key does not match, or the PEM is damaged
    } catch (err) {
      failedAt = stamp();
      onReload({ ok: false, reason: String(err?.code ?? err?.message ?? 'INVALID').slice(0, 120) });
      return false;
    }
    for (const s of servers()) s.setSecureContext?.(pair);
    seen = stamp();
    failedAt = null;
    onReload({ ok: true });
    return true;
  }

  function start() {
    if (pollMs > 0 && !timer) {
      timer = setInterval(() => { const now = stamp(); if (now && now !== seen && now !== failedAt) reload(); }, pollMs);
      timer.unref?.();
    }
    if (sighup && process.platform !== 'win32' && !onHup) { onHup = () => { reload(); }; process.on('SIGHUP', onHup); }
    return api;
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (onHup) { process.off('SIGHUP', onHup); onHup = null; }
  }
  const api = { reload, start, stop };
  return api;
}
