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

/** The statements that create the table, in order (shared by the synchronous and the asynchronous `ensure`). */
export const AUDIT_DDL = [
  `
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
  `,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor);`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity, entity_id);`,
  // I05: since/until compare the ISO-normalized timestamp (rows from before 0.1.28 hold 'YYYY-MM-DD HH:MM:SS');
  // an index on that very expression lets the date filters use it. Keep in sync with CREATED_AT_ISO in query.js.
  `CREATE INDEX IF NOT EXISTS idx_audit_log_created_iso ON audit_log((CASE WHEN created_at LIKE '____-__-__ %' THEN replace(created_at, ' ', 'T') || '.000Z' ELSE created_at END))`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_action_created ON audit_log(action, created_at);`,
];
/** Columns added to tables made by earlier versions (tamper evidence, audit B14); their old rows keep NULL hashes. */
export const AUDIT_HASH_COLUMNS = ['prev_hash', 'hash'];
/** Rows are append-only: an UPDATE is always a bug or an attack. DELETE stays possible (retention). */
export const AUDIT_NO_UPDATE_DDL = `
    CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `;

/** The same rule for PostgreSQL: a trigger function raises, the trigger runs it for every UPDATE. */
export const AUDIT_NO_UPDATE_PG_DDL = `
    CREATE OR REPLACE FUNCTION audit_log_no_update() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'audit_log is append-only'; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
    CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_no_update();
  `;

export function ensureAuditTable(db) {
  if (ensured.has(db)) return;
  for (const sql of AUDIT_DDL) db.exec(sql);
  const cols = db.all('PRAGMA table_info(audit_log)').map((c) => c.name);
  for (const c of AUDIT_HASH_COLUMNS) if (!cols.includes(c)) db.exec(`ALTER TABLE audit_log ADD COLUMN ${c} TEXT`);
  db.exec(AUDIT_NO_UPDATE_DDL);
  ensureSubjectsTable(db);
  ensured.add(db);
}
