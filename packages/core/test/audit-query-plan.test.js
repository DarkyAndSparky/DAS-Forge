import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuditTable } from '../src/audit/schema.js';

// G-12: the filters admins use most must stay on an index. Measured on 1M rows (docs/performance-budget.md):
// these four answer in under ~170 ms; a full scan would be seconds. If a refactor changes a WHERE clause
// so the planner stops using the index, this test fails before a big installation notices.
const ISO = `(CASE WHEN created_at LIKE '____-__-__ %' THEN replace(created_at, ' ', 'T') || '.000Z' ELSE created_at END)`;
const CASES = {
  actor: ['actor = ?', 1],
  action: ['action = ?', 1],
  'entity + entityId': ['entity = ? AND entity_id = ?', 2],
  'since / until': [`${ISO} >= ? AND ${ISO} <= ?`, 2],
};

describe('audit filters use an index (G-12)', () => {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuditTable(db);
  for (const [name, [where, n]] of Object.entries(CASES)) {
    it(name, () => {
      const plan = db.all(`EXPLAIN QUERY PLAN SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT 51`, Array(n).fill('x')).map((r) => r.detail).join(' | ');
      expect(plan).toMatch(/USING (COVERING )?INDEX idx_audit_log_/);
      expect(plan).not.toMatch(/SCAN audit_log(?! USING)/);
    });
  }
});
