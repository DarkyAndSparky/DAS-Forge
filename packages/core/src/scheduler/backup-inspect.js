/**
 * What a restore checks in the backup's database BEFORE it replaces the live one (audit R-02).
 * A backup is a foreign file: a trigger, a view or a virtual table inside it is code that would run in the live database
 * with its rights. Three checks, all on the staged copy, opened read-only:
 *   1. the code objects (triggers, views, virtual tables) must be the same as in the live database (name and text);
 *      a new or changed one refuses the restore. Without a live database (a rebuild after a disaster) only virtual
 *      tables are judged: anything but FTS5 is refused, and the triggers and views found are listed in the message;
 *   2. `PRAGMA trusted_schema = OFF` on that connection: functions called from the schema are not trusted;
 *   3. the audit chain inside the copy must verify (a rewritten history is refused). `allowBrokenAuditChain` lets an
 *      administrator override this after a look at the report.
 */
import { verifyChain } from '../audit/chain.js';
import { asyncDb } from '../database/async.js';

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

async function codeObjects(db) {
  const rows = await asyncDb(db).all("SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger', 'view') OR (type = 'table' AND upper(sql) LIKE 'CREATE VIRTUAL TABLE%')");
  return new Map(rows.map((r) => [`${r.type}:${r.name}`, norm(r.sql)]));
}

/**
 * @returns {Promise<{ ok: boolean, message: string, details?: string[] }>}
 */
export async function inspectStagedDatabase({ createAdapterFn, stagedPath, livePath = null, allowBrokenAuditChain = false, existsSync }) {
  let staged;
  let live = null;
  try {
    staged = createAdapterFn({ file: stagedPath, walMode: false, readonly: true });
    try { staged.run('PRAGMA trusted_schema = OFF'); } catch { /* an adapter that cannot take a pragma: the other checks stay */ }
    const found = await codeObjects(staged);
    const bad = [];
    if (livePath && existsSync(livePath)) {
      try {
        live = createAdapterFn({ file: livePath, walMode: false, readonly: true });
      } catch { live = null; }
    }
    if (live) {
      const known = await codeObjects(live);
      for (const [key, sql] of found) if (known.get(key) !== sql) bad.push(`${key} ${known.has(key) ? 'differs from the live database' : 'is not in the live database'}`);
    } else {
      for (const [key, sql] of found) if (key.startsWith('table:') && !/using\s+fts5\b/.test(sql)) bad.push(`${key} is a virtual table that is not FTS5`);
    }
    if (bad.length > 0) return { ok: false, message: `the backup holds code that the live database does not have: ${bad.slice(0, 5).join('; ')}${bad.length > 5 ? ` (+${bad.length - 5})` : ''}`, details: bad };

    let chain;
    const hasAudit = await asyncDb(staged).get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'");
    if (!hasAudit) chain = { ok: true, checked: 0 }; // an application without the audit table has no chain
    else { try { chain = verifyChain(staged, { readOnly: true }); } catch (err) { chain = { ok: false, reason: err.message }; } }
    if (!chain.ok && !allowBrokenAuditChain) return { ok: false, message: `the audit chain in the backup is broken at row ${chain.brokenAtId ?? '?'}: ${chain.reason} (override: allowBrokenAuditChain)` };
    const extra = live ? 'triggers, views and virtual tables match the live database' : `no live database to compare; ${[...found.keys()].filter((k) => !k.startsWith('table:')).length} trigger/view object(s) not compared`;
    return { ok: true, message: `${extra}; audit chain ${chain.ok ? `verified (${chain.checked} row(s))` : 'BROKEN but allowed'}` };
  } catch (err) {
    return { ok: false, message: `could not inspect the backup database: ${err.message}` };
  } finally {
    try { live?.close(); } catch { /* closed */ }
    try { staged?.close(); } catch { /* closed */ }
  }
}
