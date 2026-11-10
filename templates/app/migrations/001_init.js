/**
 * A migration exports a SYNCHRONOUS up(db): the database transaction does not wait for an async callback.
 * Files are applied in name order at every start (and by `npm run cli -- migrate`); an applied one is never run again.
 * This one creates the example table behind src/notes.js: replace it with your own model.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
