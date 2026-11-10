/** Persists each job's last run time so missed runs can be caught up after downtime (audit B15). */
export function createDbLastRunStore(db) {
  db.run(`CREATE TABLE IF NOT EXISTS scheduler_state (name TEXT PRIMARY KEY, last_run_at TEXT NOT NULL)`);
  return {
    get: (name) => db.get(`SELECT last_run_at FROM scheduler_state WHERE name = ?`, [name])?.last_run_at ?? null,
    set: (name, iso) =>
      db.run(
        `INSERT INTO scheduler_state (name, last_run_at) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at`,
        [name, iso]
      ),
  };
}
