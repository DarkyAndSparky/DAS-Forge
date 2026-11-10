import { randomBytes } from 'node:crypto';
import { ensureAuthTables } from './schema.js';
import { hashPassword, verifyPassword } from './password.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - avoids transcription errors reading off a printed sheet

function randomCode() {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/**
 * §22: generates `count` one-time recovery codes, stores only their
 * argon2 hash (reusing core/auth's own hashPassword - a recovery code
 * is exactly as sensitive as a password, there's no reason to invent a
 * second hashing primitive for it), and returns the PLAINTEXT codes
 * once - this is the only moment they're ever visible; they cannot be
 * retrieved again after this call returns, only regenerated (which
 * invalidates the old set).
 *
 * Always a full reset: any existing codes for this user are deleted
 * first, matching the doc's "Regenerate" button semantics (§17) - there
 * is no "add more codes to the existing set" operation, which would
 * make it unclear to the user which sheet of codes is still valid.
 */
export async function generateRecoveryCodes(db, userId, { count = 8 } = {}) {
  ensureAuthTables(db);

  // Hash everything first (the awaits), then swap the whole set in one transaction:
  // a failure half-way must not leave the user with no codes or an incomplete sheet (audit K08).
  const codes = Array.from({ length: count }, randomCode);
  const hashes = [];
  for (const code of codes) hashes.push(await hashPassword(code));
  db.transaction(() => {
    db.run(`DELETE FROM recovery_codes WHERE user_id = ?`, [userId]);
    for (const hash of hashes) db.run(`INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)`, [userId, hash]);
  });
  return codes;
}

/**
 * Checks `code` against every UNUSED recovery code hash for this user;
 * on a match, marks that one row used (one-time use, §22 - "повторно
 * использовать код нельзя") and returns true. Checks are sequential
 * argon2 verifies, not parallelized - recovery login is rare enough
 * that this is a non-issue in practice, called out here rather than
 * silently assumed.
 */
export async function verifyAndConsumeRecoveryCode(db, userId, code) {
  ensureAuthTables(db);
  const rows = db.all(`SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL`, [userId]);

  for (const row of rows) {
    // verifyPassword resolves to { valid, scheme, needsRehash }, not a
    // bare boolean (see password.js) - truthiness-testing the object
    // itself is always true regardless of `.valid`, which was the bug
    // here: the very first unused row "matched" every time, so a wrong
    // code still got accepted (and consumed someone else's valid row).
    const result = await verifyPassword(row.code_hash, code);
    if (result.valid) {
      // The UPDATE is the check (audit K01): the argon2 verify above awaits, so two requests
      // with the same code can both reach this line - only the one that flips the row wins.
      const claimed = db.run(`UPDATE recovery_codes SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL`, [row.id]);
      if (claimed.changes === 1) return true;
    }
  }
  return false;
}

/** For the "N codes remaining" display (§17). */
export function countRemainingRecoveryCodes(db, userId) {
  ensureAuthTables(db);
  return db.get(`SELECT COUNT(*) AS c FROM recovery_codes WHERE user_id = ? AND used_at IS NULL`, [userId]).c;
}
