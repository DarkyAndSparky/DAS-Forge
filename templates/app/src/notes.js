/**
 * The example data model: plain SQL over the `notes` table, no ORM. Replace it with your own domain code;
 * keep the shape: small functions that take `db` first and return plain objects.
 */
const toNote = (r) => ({ id: r.id, body: r.body, author: r.author, createdAt: r.created_at });

export function listNotes(db, { limit = 100 } = {}) {
  return db.all('SELECT id, body, author, created_at FROM notes ORDER BY id DESC LIMIT ?', [Math.min(500, Math.max(1, Number(limit) || 100))]).map(toNote);
}

export function createNote(db, { body, author }) {
  const id = Number(db.run('INSERT INTO notes (body, author) VALUES (?, ?)', [body, author]).lastInsertRowid);
  return toNote(db.get('SELECT id, body, author, created_at FROM notes WHERE id = ?', [id]));
}

/** @returns {boolean} whether a row was removed */
export function deleteNote(db, id) {
  return (db.run('DELETE FROM notes WHERE id = ?', [id]).changes ?? 0) > 0;
}
