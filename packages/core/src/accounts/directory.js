import { asyncDb } from '../database/async.js';

/**
 * Which local accounts are managed by an external directory (LDAP / AD).
 * Only a linked account signs in against the directory; every other local account keeps checking its own password,
 * so a directory entry can never take over a local account that happens to have the same name.
 */
const DIRECTORY_DDL = `CREATE TABLE IF NOT EXISTS directory_links (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    dn TEXT,
    created_at TEXT NOT NULL
  )`;
const GET_SQL = 'SELECT source, dn FROM directory_links WHERE user_id = ?';
const LINK_SQL = `INSERT INTO directory_links (user_id, source, dn, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET source = excluded.source, dn = excluded.dn, created_at = excluded.created_at`;
const linkArgs = (userId, source, dn) => [userId, String(source), dn == null ? null : String(dn), new Date().toISOString()];

/** The table over `asyncDb`. Call once at start-up, outside a transaction. */
export async function ensureDirectoryLinksTableAsync(db) { await asyncDb(db).exec(DIRECTORY_DDL); }

export function createDirectoryLinks(db) {
  db.exec(DIRECTORY_DDL);
  const a = asyncDb(db);
  return {
    get: (userId) => db.get(GET_SQL, [userId]) ?? null,
    link: (userId, source, dn) => { db.run(LINK_SQL, linkArgs(userId, source, dn)); },
    getAsync: async (userId) => (await a.get(GET_SQL, [userId])) ?? null,
    linkAsync: async (userId, source, dn) => { await a.run(LINK_SQL, linkArgs(userId, source, dn)); },
  };
}
