import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Erasure ledger (audit F08): a small append-only file kept OUTSIDE the database. `backup restore` brings
 * back an older database - with the people who were erased after that backup. The ledger remembers who
 * was erased (user id + a salted hash of the login, never the login itself) so `reapplyErasures()` can
 * erase them again in the restored database. Entries are matched by id AND login hash, so an unrelated
 * account is never touched. Back this file up separately from the database backups (it is tiny).
 */
const hashOf = (salt, username) => createHash('sha256').update(`${salt}\0${String(username).toLowerCase()}`).digest('hex');

export function createErasureLedger(file) {
  function load() {
    if (!existsSync(file)) return { salt: null, entries: [] };
    let salt = null;
    const entries = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.salt) salt = j.salt;
        else if (Number.isInteger(j.userId) && j.h && (j.mode === 'anonymize' || j.mode === 'delete')) entries.push(j);
      } catch { /* a damaged line is skipped, not fatal */ }
    }
    return { salt, entries };
  }

  function record({ userId, username, mode, at = new Date().toISOString() }) {
    let { salt } = load();
    mkdirSync(path.dirname(file), { recursive: true });
    if (!salt) {
      salt = randomBytes(16).toString('hex');
      writeFileSync(file, `${JSON.stringify({ salt })}\n`, { mode: 0o600 });
    }
    appendFileSync(file, `${JSON.stringify({ userId, h: hashOf(salt, username), mode, at })}\n`);
    try { chmodSync(file, 0o600); } catch { /* not supported on this platform */ }
  }

  const entries = () => load().entries;

  /**
   * Erase again whoever the ledger lists and the (restored) database still has under that id AND login.
   * `erase({userId, mode})` is the app's eraseUserData bound to the database being repaired.
   * @returns {Promise<{checked:number, reapplied:number[], skipped:number}>}
   */
  async function reapply({ db, findUserByIdFn, erase }) {
    const { salt, entries: list } = load();
    const reapplied = [];
    let skipped = 0;
    for (const e of list) {
      const user = findUserByIdFn(db, e.userId);
      if (!user || !user.username || hashOf(salt, user.username) !== e.h) { skipped++; continue; }
      await erase({ userId: e.userId, mode: e.mode });
      reapplied.push(e.userId);
    }
    return { checked: list.length, reapplied, skipped };
  }

  return { record, entries, reapply, file };
}
