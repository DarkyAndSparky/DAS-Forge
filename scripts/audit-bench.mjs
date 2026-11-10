// G-12: audit filter timings on N rows (default 1 000 000, ~10 s to fill). Usage: node scripts/audit-bench.mjs [rows]
// Numbers go to docs/performance-budget.md; run on the target server before trusting them.
const root = new URL("../packages/core", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"); const N = Number(process.argv[2] || 1000000);
const imp = (p) => import(`${root}/src/${p}`);
const { createSqliteAdapter } = await imp('database/sqlite-adapter.js');
const { ensureAuditTable } = await imp('audit/schema.js');
const q = await imp('audit/query.js');
const db = createSqliteAdapter({ file: ':memory:' });
ensureAuditTable(db);
const acts = ['login','logout','user.create','user.update','backup.run','audit.export','settings.change','password.change'];
const t0 = Date.now();
db.exec('BEGIN');
const st = db.raw ? null : null;
for (let i = 0; i < N; i++) {
  const d = new Date(Date.UTC(2025, 0, 1) + i * 25000).toISOString();
  db.run('INSERT INTO audit_log (actor,action,entity,entity_id,result,meta,request_id,ip,created_at,hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ['u' + (i % 500), acts[i % 8], i % 3 ? 'user' : 'backup', String(i % 10000), i % 20 ? 'success' : 'failure', '{}', 'r' + i, '10.0.0.1', d, 'h']);
}
db.exec('COMMIT');
console.log('insert', N, 'rows', Date.now() - t0, 'ms');
db.exec('ANALYZE');
const cases = {
  'page latest 50': () => q.page(db, { limit: 50 }),
  'actor': () => q.page(db, { actor: 'u7', limit: 50 }),
  'action': () => q.page(db, { action: 'login', limit: 50 }),
  'actionPrefix user.': () => q.page(db, { actionPrefix: 'user.', limit: 50 }),
  'actionContains': () => q.page(db, { actionContains: 'word', limit: 50 }),
  'entity+id': () => q.page(db, { entity: 'user', entityId: '77', limit: 50 }),
  'entityId only': () => q.page(db, { entityId: '77', limit: 50 }),
  'requestId': () => q.page(db, { requestId: 'r777777', limit: 50 }),
  'result=failure': () => q.page(db, { result: 'failure', limit: 50 }),
  'since/until 1 day': () => q.page(db, { since: '2025-06-01T00:00:00Z', until: '2025-06-02T00:00:00Z', limit: 50 }),
  'actor+since': () => q.page(db, { actor: 'u7', since: '2025-06-01T00:00:00Z', limit: 50 }),
  'rare actor': () => q.page(db, { actor: 'nobody', limit: 50 }),
  'rare action': () => q.page(db, { action: 'nothing', limit: 50 }),
  'rare requestId': () => q.page(db, { requestId: 'zzz', limit: 50 }),
  'rare entityId': () => q.page(db, { entityId: 'zzz', limit: 50 }),
  'rare result': () => q.page(db, { result: 'denied', limit: 50 }),
  'rare contains': () => q.page(db, { actionContains: 'zzzz', limit: 50 }),
  'count all': () => q.count(db, {}),
  'count action': () => q.count(db, { action: 'login' }),
  'count day': () => q.count(db, { since: '2025-06-01T00:00:00Z', until: '2025-06-02T00:00:00Z' }),
};
for (const [name, f] of Object.entries(cases)) { const t = Date.now(); let r; try { r = f(); } catch (e) { r = e.message; } console.log(String(Date.now() - t).padStart(6), 'ms', name, typeof r === 'string' ? 'ERR ' + r : JSON.stringify(r).slice(0, 60)); }
