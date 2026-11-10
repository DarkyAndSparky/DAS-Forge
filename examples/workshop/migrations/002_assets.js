/**
 * Stage C (Demo Records, §0.3): the ASSETS array that used to live
 * hardcoded in routes.js becomes a real table. Same migration
 * convention as 001_init.js - MUST export a synchronous up(db).
 *
 * `cost` and `logo_filename` are nullable on purpose: a record is
 * valid without either - cost is set through its own finance-gated
 * endpoint (POST /assets/:id/cost), never on create, and a logo is
 * optional entirely.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      org TEXT NOT NULL,
      cost REAL,
      logo_filename TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
