/**
 * Which local accounts are managed by an external directory (LDAP / AD).
 * Only a linked account signs in against the directory; every other local account keeps checking its own password,
 * so a directory entry can never take over a local account that happens to have the same name.
 */
export function createDirectoryLinks(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS directory_links (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    dn TEXT,
    created_at TEXT NOT NULL
  )`);
  return {
    get: (userId) => db.get('SELECT source, dn FROM directory_links WHERE user_id = ?', [userId]) ?? null,
    link: (userId, source, dn) => { db.run('INSERT OR REPLACE INTO directory_links (user_id, source, dn, created_at) VALUES (?, ?, ?, ?)', [userId, String(source), dn == null ? null : String(dn), new Date().toISOString()]); },
  };
}
