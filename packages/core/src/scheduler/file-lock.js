import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Cross-process lock via an exclusively-created file (audit B15), so the
 * server's scheduled backup and `app backup run` from the CLI never run
 * at the same time. A lock is stale - and taken over - when its owner pid
 * is gone or it is older than `staleMs` (default 1h).
 * `staleMs: Infinity` makes only a dead owner pid count as stale (a long-lived holder like the
 * server). `takeOverSelf`: a lock file naming THIS pid is a leftover of a crashed earlier run
 * (a container restarts with the same pid) and is taken over.
 * @returns {(() => void) | null} release function, or null if held by someone else
 */
export function acquireFileLock(file, { staleMs = 60 * 60 * 1000, takeOverSelf = false } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          unlinkSync(file);
        } catch {
          /* already removed */
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let info = null;
      try {
        info = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        /* unreadable/partial lock file counts as stale */
      }
      const stale = !info || !pidAlive(info.pid) || (takeOverSelf && info.pid === process.pid) || Date.now() - info.at > staleMs;
      if (!stale) return null;
      try {
        unlinkSync(file);
      } catch {
        /* someone else cleaned it first */
      }
    }
  }
  return null;
}

/** Who holds the lock right now ({pid, at}), or null when free/stale-unreadable. */
export function readLockOwner(file) {
  try {
    const info = JSON.parse(readFileSync(file, 'utf8'));
    return pidAlive(info.pid) ? info : null;
  } catch {
    return null;
  }
}
