/**
 * Stage C (Demo Records, §0.3): plain SQL access for the `assets`
 * table (migrations/002_assets.js) - routes.js's job is translating
 * HTTP in and out, never building SQL itself, same separation every
 * core/* module already follows (e.g. core/auth's users.js vs
 * sessions.js vs the HTTP-facing routes that call them).
 *
 * Replaces the old hardcoded in-memory ASSETS array that used to live
 * directly in routes.js - that was fine for demonstrating serialize()'s
 * field-permission stripping in isolation, but Stage C's whole point is
 * database+http+files working together end to end, which an in-memory
 * array can't demonstrate.
 */

function rowToAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    org: row.org,
    cost: row.cost,
    logoFilename: row.logo_filename,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAssets(db) {
  return db.all(`SELECT * FROM assets ORDER BY id`).map(rowToAsset);
}

export function getAsset(db, id) {
  return rowToAsset(db.get(`SELECT * FROM assets WHERE id = ?`, [id]));
}

export function createAsset(db, { name, org }) {
  const result = db.run(`INSERT INTO assets (name, org) VALUES (?, ?)`, [name, org]);
  return getAsset(db, result.lastInsertRowid);
}

/** Only name/org - cost has its own finance-gated setter below, on
 * purpose, so "can edit a record" and "can see/change its cost" stay
 * two separate permission checks all the way down to the SQL layer,
 * not just at the HTTP route. */
export function updateAsset(db, id, { name, org }) {
  if (!getAsset(db, id)) return null;
  db.run(`UPDATE assets SET name = ?, org = ?, updated_at = datetime('now') WHERE id = ?`, [name, org, id]);
  return getAsset(db, id);
}

export function setAssetCost(db, id, cost) {
  if (!getAsset(db, id)) return null;
  db.run(`UPDATE assets SET cost = ?, updated_at = datetime('now') WHERE id = ?`, [cost, id]);
  return getAsset(db, id);
}

export function setAssetLogo(db, id, logoFilename) {
  if (!getAsset(db, id)) return null;
  db.run(`UPDATE assets SET logo_filename = ?, updated_at = datetime('now') WHERE id = ?`, [logoFilename, id]);
  return getAsset(db, id);
}

/** @returns {boolean} whether a row actually existed and was removed */
export function deleteAsset(db, id) {
  const result = db.run(`DELETE FROM assets WHERE id = ?`, [id]);
  return result.changes > 0;
}

/** Demo seed data, inserted once on a genuinely empty table - mirrors
 * the two hardcoded rows the old in-memory array used to ship with, so
 * a fresh `npm start` still has something to look at immediately. */
export function seedAssetsIfEmpty(db) {
  const { count } = db.get(`SELECT COUNT(*) AS count FROM assets`);
  if (count > 0) return;
  db.run(`INSERT INTO assets (name, org, cost) VALUES (?, ?, ?)`, ['Dell Latitude 5420', 'IT', 950]);
  db.run(`INSERT INTO assets (name, org, cost) VALUES (?, ?, ?)`, ['HP Switch 24p', 'NET', 1800]);
}
