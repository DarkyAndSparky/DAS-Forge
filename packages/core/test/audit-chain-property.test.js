import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { log, verifyChain, anchor } from '../src/audit/index.js';

// Property-style tests (G-10) with a seeded generator: no extra dependency,
// and a failure is reproducible - the seed is in the test name.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
const WORDS = ['login', 'user.create', 'backup.run', 'пользователь', 'a"b', "o'k", 'x\ny', ''];

function build(seed, n) {
  const r = rng(seed);
  const db = createSqliteAdapter({ file: ':memory:' });
  for (let i = 0; i < n; i++) {
    log(db, {
      action: `act.${pick(r, WORDS) || 'z'}${i}`,
      actor: r() < 0.2 ? undefined : pick(r, ['u1', 'u2', 'админ']),
      entity: r() < 0.5 ? pick(r, ['user', 'backup']) : undefined,
      entityId: r() < 0.5 ? String(Math.floor(r() * 1000)) : undefined,
      result: r() < 0.8 ? 'success' : 'failure',
      meta: r() < 0.5 ? { n: i, w: pick(r, WORDS) } : undefined,
    });
  }
  return { db, r };
}
// The table is append-only (triggers); an attacker with DB write access can drop them, so the tests do too.
function attacker(db) {
  for (const t of db.all(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)) db.exec(`DROP TRIGGER ${t.name}`);
  return db;
}
const ids = (db) => db.all('SELECT id FROM audit_log ORDER BY id').map((x) => x.id);

describe('audit chain: properties', () => {
  for (const seed of [1, 7, 42, 2026, 99991]) {
    it(`any sequence of entries verifies (seed ${seed})`, () => {
      const n = 5 + (seed % 40);
      const { db } = build(seed, n);
      expect(verifyChain(db)).toEqual({ ok: true, checked: n });
    });

    it(`changing any field of any row is detected at that row (seed ${seed})`, () => {
      const { db, r } = build(seed, 30);
      const all = ids(db);
      attacker(db);
      for (let k = 0; k < 8; k++) {
        const id = pick(r, all);
        const col = pick(r, ['actor', 'action', 'entity', 'entity_id', 'result', 'meta', 'request_id', 'ip', 'created_at']);
        const before = db.get(`SELECT ${col} AS v FROM audit_log WHERE id=?`, [id]).v;
        db.run(`UPDATE audit_log SET ${col}=? WHERE id=?`, [`${before ?? ''}~`, id]);
        const res = verifyChain(db);
        expect(res.ok).toBe(false);
        expect(res.brokenAtId).toBe(id);
        db.run(`UPDATE audit_log SET ${col}=? WHERE id=?`, [before, id]);
        expect(verifyChain(db).ok).toBe(true);
      }
    });

    it(`deleting a middle row is detected at the next row (seed ${seed})`, () => {
      const { db, r } = build(seed, 20);
      const all = ids(db);
      attacker(db);
      const i = 1 + Math.floor(r() * (all.length - 2));
      db.run('DELETE FROM audit_log WHERE id=?', [all[i]]);
      const res = verifyChain(db);
      expect(res.ok).toBe(false);
      expect(res.brokenAtId).toBe(all[i + 1]);
    });

    it(`tail truncation is invisible to the chain but caught by the anchor (seed ${seed})`, () => {
      const { db, r } = build(seed, 20);
      const a = anchor(db);
      attacker(db);
      const cut = 1 + Math.floor(r() * 5);
      db.run('DELETE FROM audit_log WHERE id > ?', [ids(db).at(-1) - cut]);
      expect(verifyChain(db).ok).toBe(true);
      const res = verifyChain(db, { anchor: a });
      expect(res.ok).toBe(false);
      expect(res.brokenAtId).toBe(a.id);
    });
  }

  it('retention of the oldest rows keeps the rest verifiable', () => {
    const { db } = build(5, 30);
    attacker(db);
    db.run('DELETE FROM audit_log WHERE id <= ?', [ids(db)[9]]);
    expect(verifyChain(db)).toEqual({ ok: true, checked: 20 });
  });
});

describe('audit chain: volume (G-10)', () => {
  it('verifies across the 2000-row page boundary and finds a break on the second page', () => {
    const n = 4300;
    const { db } = build(11, n);
    const t0 = Date.now();
    expect(verifyChain(db)).toEqual({ ok: true, checked: n });
    const ms = Date.now() - t0;
    expect(ms < 15000).toBe(true); // generous: catches an accidental quadratic walk, not machine speed
    attacker(db);
    const victim = ids(db)[2500];
    db.run(`UPDATE audit_log SET result='failure~' WHERE id=?`, [victim]);
    expect(verifyChain(db)).toMatchObject({ ok: false, brokenAtId: victim, checked: 2500 });
  }, 60000);
});
