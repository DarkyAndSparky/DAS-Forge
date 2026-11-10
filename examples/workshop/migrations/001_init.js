/**
 * Example migration - MUST export a synchronous up(db), per
 * core/cli/migrator.js (core/database's transaction() doesn't await an
 * async callback, so an async up() here would have its work race the
 * transaction's COMMIT).
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
