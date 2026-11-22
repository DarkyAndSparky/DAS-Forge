import { describe, it, expect, afterEach } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { log, verifyChain, setSealKeys, sealingActive } from '../src/audit/index.js';
import { computeHash } from '../src/audit/chain.js';

const K1 = 'k'.repeat(32);
const K2 = 'z'.repeat(32);
afterEach(() => setSealKeys(null));

function fill(n) {
  const db = createSqliteAdapter({ file: ':memory:' });
  for (let i = 0; i < n; i++) log(db, { actor: 'a', action: `t.${i}` });
  return db;
}
/** What someone with write access to the file can do: drop the guard trigger, then rewrite a row and recompute the whole chain. */
function forge(db, id, action) {
  db.exec('DROP TRIGGER audit_log_no_update');
  const rows = db.all('SELECT * FROM audit_log ORDER BY id');
  let prev = null;
  for (const r of rows) {
    const row = { ...r, action: r.id === id ? action : r.action };
    const hash = computeHash(prev, row);
    db.run('UPDATE audit_log SET action = ?, prev_hash = ?, hash = ? WHERE id = ?', [row.action, prev, hash, r.id]);
    prev = hash;
  }
}

describe('audit seal (audit R-01)', () => {
  it('without a key rows have no seal and the chain verifies as before', () => {
    const db = fill(3);
    expect(sealingActive()).toBe(false);
    expect(db.all('SELECT seal FROM audit_log').every((r) => r.seal === null)).toBe(true);
    expect(verifyChain(db)).toEqual({ ok: true, checked: 3 });
  });

  it('a chain recomputed by someone without the key breaks, a sealed one verifies', () => {
    setSealKeys(K1);
    const db = fill(4);
    expect(verifyChain(db)).toMatchObject({ ok: true, checked: 4, sealed: 4 });
    forge(db, 2, 'forged.action');
    const r = verifyChain(db);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/seal does not match/);
  });

  it('an unsealed row after sealing had started is a break (rows written without the key)', () => {
    setSealKeys(K1);
    const db = fill(2);
    setSealKeys(null);
    log(db, { actor: 'a', action: 'later.without.key' });
    setSealKeys(K1);
    const r = verifyChain(db);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/without a seal/);
  });

  it('rows from before sealing started stay valid; a rotated key still verifies old rows', () => {
    const db = fill(2); // unsealed history
    setSealKeys(K1);
    log(db, { actor: 'a', action: 's1' });
    setSealKeys([K2, K1]); // K2 signs now, K1 still verifies
    log(db, { actor: 'a', action: 's2' });
    expect(verifyChain(db)).toMatchObject({ ok: true, checked: 4, sealed: 2 });
    expect(verifyChain(db, { sealKey: K2 }).ok).toBe(false); // K1 dropped too early
  });

  it('a run without a key reports sealed rows it could not check instead of failing', () => {
    setSealKeys(K1);
    const db = fill(2);
    setSealKeys(null);
    expect(verifyChain(db)).toMatchObject({ ok: true, sealed: 0, unverifiedSeals: 2 });
  });

  it('too short a key does not seal', () => {
    setSealKeys('short');
    expect(sealingActive()).toBe(false);
  });
});
