import { z } from 'zod';
import { ensureSubjectsTable } from './subjects.js';

/**
 * §7.5-style data schema for an audit entry. Same rule as core/config
 * and core/auth: this validates DATA (a row), not a behavioral
 * interface - there is no "AuditProvider" contract to duck-type here,
 * audit is a single concrete module (log/query against core/database),
 * not pluggable per-app.
 *
 * Captures who/what/when/result per the architecture doc's
 * `audit.log({ actor, action, entity, meta })` API plus the fields
 * needed to actually make the log useful: entityId (which row),
 * result (success/failure - a denied permission check is as
 * important to log as a successful one), and requestId/ip to
 * correlate with core/http's request context.
 */
export const AuditEntrySchema = z.object({
  id: z.number().int().positive().optional(),
  // null actor = unauthenticated / system-initiated (e.g. a scheduled
  // backup job), not an error case - do not require a user here.
  actor: z.string().nullable().default(null),
  // dot-namespaced verb, e.g. 'auth.login', 'asset.dispose',
  // 'permission.denied'. Free-form by design - core doesn't know the
  // app's action vocabulary (same boundary as everywhere else: core is
  // mechanism, the app decides what actions mean).
  action: z.string().min(1),
  // entity TYPE ('user', 'asset', ...), not the row itself.
  entity: z.string().nullable().default(null),
  entityId: z.union([z.string(), z.number()]).nullable().default(null),
  result: z.enum(['success', 'failure', 'denied']).default('success'),
  meta: z.record(z.string(), z.unknown()).default({}),
  requestId: z.string().nullable().default(null),
  ip: z.string().nullable().default(null),
  createdAt: z.string().datetime().optional(),
});

/**
 * Creates the audit_log table if it doesn't exist yet, plus indexes
 * for the three ways the log actually gets queried: recency (tail),
 * by actor ("what did this user do"), and by entity ("history of this
 * record"). Append-only by convention - nothing in this module exposes
 * an UPDATE, only log() (insert) and purgeOlderThan() (retention, see
 * retention.js).
 */
const ensured = new WeakSet();

export function ensureAuditTable(db) {
  if (ensured.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT,
      action TEXT NOT NULL,
      entity TEXT,
      entity_id TEXT,
      result TEXT NOT NULL DEFAULT 'success',
      meta TEXT NOT NULL DEFAULT '{}',
      request_id TEXT,
      ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity, entity_id);`);
  // I05: since/until compare the ISO-normalized timestamp (rows from before 0.1.28 hold 'YYYY-MM-DD HH:MM:SS');
  // an index on that very expression lets the date filters use it. Keep in sync with CREATED_AT_ISO in query.js.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_created_iso ON audit_log((CASE WHEN created_at LIKE '____-__-__ %' THEN replace(created_at, ' ', 'T') || '.000Z' ELSE created_at END))`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_action_created ON audit_log(action, created_at);`);

  // Tamper evidence (audit B14): every row stores the hash of the row
  // before it (prev_hash) and its own hash, so editing or deleting a row
  // in the middle is detectable with verifyChain(). Tables created by
  // earlier versions get the columns added in place; their old rows have
  // NULL hashes and are simply not covered.
  const cols = db.all('PRAGMA table_info(audit_log)').map((c) => c.name);
  if (!cols.includes('prev_hash')) db.exec('ALTER TABLE audit_log ADD COLUMN prev_hash TEXT');
  if (!cols.includes('hash')) db.exec('ALTER TABLE audit_log ADD COLUMN hash TEXT');

  // Rows are append-only: an UPDATE is always a bug or an attack. DELETE
  // stays possible (retention, purgeOlderThan) - a gap in the middle of
  // the chain is what verifyChain() reports.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `);
  ensureSubjectsTable(db);
  ensured.add(db);
}
