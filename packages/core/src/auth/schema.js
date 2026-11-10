import { z } from 'zod';

/**
 * §7.5 UserSchema / SessionSchema. These validate DATA (rows), same
 * rule as core/config: behavioral interfaces (AuthProvider itself) are
 * NOT Zod schemas, see adapter.js.
 */
export const UserSchema = z.object({
  id: z.number().int().positive().optional(),
  username: z.string().min(1).max(190),
  email: z.string().email().nullable().default(null),
  passwordHash: z.string(),
  role: z.string().default('operator'),
  mustChangePassword: z.boolean().default(false),
  totpSecret: z.string().nullable().default(null),
  totpEnabled: z.boolean().default(false),
  disabled: z.boolean().default(false),
  createdAt: z.string().datetime().optional(),
});

export const SessionSchema = z.object({
  id: z.string(),
  userId: z.number().int().positive(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  data: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Multi-authenticator model (discussed with the user against a shared
 * security-architecture doc, adopted incrementally - see authenticators.js
 * for the full rationale). Supersedes the flat `users.totp_secret`/
 * `totp_enabled` columns above, which stay in the table (read once by
 * the migration in ensureAuthTables() below, never written by new code)
 * rather than being dropped - no destructive schema change for columns
 * that might still hold real data in an app that adopted them early.
 *
 * `type` is constrained to 'totp' by a CHECK, not left open for
 * 'webauthn' - unlike core/modules' dataSubject (accept now, wire up
 * later), an authenticator with no verify function behind it isn't
 * harmless stored data, it's a security hole: a row a user could
 * believe is a working second factor that nothing can ever check.
 * 'webauthn' becomes a valid value only alongside an actual WebAuthn
 * verify implementation, not before it.
 */
export const AuthenticatorSchema = z.object({
  id: z.number().int().positive().optional(),
  userId: z.number().int().positive(),
  type: z.literal('totp'),
  status: z.enum(['pending', 'active']).default('pending'),
  name: z.string().nullable().default(null),
  createdAt: z.string().datetime().optional(),
  lastUsedAt: z.string().datetime().nullable().default(null),
  expiresAt: z.string().datetime().nullable().default(null),
});

export const RecoveryCodeSchema = z.object({
  id: z.number().int().positive().optional(),
  userId: z.number().int().positive(),
  codeHash: z.string(),
  createdAt: z.string().datetime().optional(),
  usedAt: z.string().datetime().nullable().default(null),
});

/**
 * Creates the users/sessions tables if they don't exist yet. Generic
 * enough to serve all 4 apps - app-specific profile fields belong in a
 * separate app-owned table joined on userId, not bolted onto this one.
 */
const sessionsPurged = new WeakSet();

export function ensureAuthTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      email TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'operator',
      must_change_password INTEGER NOT NULL DEFAULT 0,
      totp_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT,
      data TEXT NOT NULL DEFAULT '{}'
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
  `);

  // When the password was last chosen (NULL = not stamped yet; the password-age check stamps it on first sight) and the previous hashes.
  if (!db.all('PRAGMA table_info(users)').some((c) => c.name === 'password_changed_at')) {
    db.exec('ALTER TABLE users ADD COLUMN password_changed_at TEXT');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_password_history_user ON password_history(user_id, id);
  `);

  // Databases created before idle-timeout existed (audit A12).
  if (!db.all('PRAGMA table_info(sessions)').some((c) => c.name === 'last_seen_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN last_seen_at TEXT');
  }

  // express-session may save a session before anyone has logged in, so user_id must
  // allow NULL. SQLite cannot drop NOT NULL in place: rebuild the table once.
  if (db.all('PRAGMA table_info(sessions)').some((c) => c.name === 'user_id' && c.notnull === 1)) {
    db.exec(`
      CREATE TABLE sessions_rebuild (
        id TEXT PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT,
        data TEXT NOT NULL DEFAULT '{}'
      );
      INSERT INTO sessions_rebuild (id, user_id, created_at, expires_at, last_seen_at, data)
        SELECT id, user_id, created_at, expires_at, last_seen_at, data FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_rebuild RENAME TO sessions;
    `);
  }

  // Sessions stored under their raw id (before 0.1.64, audit A11) can no longer be
  // looked up and must not linger readable: drop them once per process and database.
  if (!sessionsPurged.has(db)) {
    sessionsPurged.add(db);
    if (db.all('PRAGMA table_info(sessions)').length > 0) db.run(`DELETE FROM sessions WHERE id NOT LIKE 'h1:%'`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS authenticators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('totp')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
      name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      expires_at TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_authenticators_user ON authenticators(user_id);`);

  // One credential row per authenticator, split from the generic table
  // (rather than bolted onto it) so a future 'webauthn' type's very
  // different credential shape (public key, counter, transports...)
  // doesn't force nullable TOTP-only columns onto every authenticator
  // row regardless of type.
  //
  // No `algorithm`/`digits` columns: core/auth/totp.js's generateTotp()/
  // verifyTotp() hardcode HMAC-SHA1 and 6 digits (the universal Google
  // Authenticator-compatible default) - storing a column nothing reads
  // would be the same mistake as the Zod schema fields that validate
  // data no code acts on. `period` IS configurable (verifyTotp's
  // `stepSeconds`), so it's a real column.
  db.exec(`
    CREATE TABLE IF NOT EXISTS totp_credentials (
      authenticator_id INTEGER PRIMARY KEY REFERENCES authenticators(id) ON DELETE CASCADE,
      secret TEXT NOT NULL,
      period INTEGER NOT NULL DEFAULT 30,
      last_used_step INTEGER
    );
  `);
  // Databases created before replay protection existed (audit A07).
  if (!db.all('PRAGMA table_info(totp_credentials)').some((c) => c.name === 'last_used_step')) {
    db.exec('ALTER TABLE totp_credentials ADD COLUMN last_used_step INTEGER');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      used_at TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id);`);

  migrateLegacyTotpSecrets(db);
}

/**
 * One-time migration: any user row still carrying the legacy flat
 * `totp_secret` gets an equivalent `authenticators` + `totp_credentials`
 * row created for it (status 'active' if `totp_enabled` was set, since
 * that column meant exactly "this secret is verified and in use").
 * Idempotent - re-checks `authenticators` for an existing totp row for
 * that user before creating another, so running ensureAuthTables() on
 * every startup never duplicates it. The legacy columns are left as-is
 * (not nulled out) - this is an additive migration, not a cutover, in
 * case anything still reads them.
 */
function migrateLegacyTotpSecrets(db) {
  // Guard: `CREATE TABLE IF NOT EXISTS users` above is a no-op against a
  // `users` table that already exists with a different shape (a test
  // fixture, or an app that creates its own minimal `users` table before
  // anything in core touches the db) - it does NOT add the legacy columns
  // to that existing table. Without this check, the SELECT below would
  // throw "no such column: totp_secret" on exactly that case, rather than
  // harmlessly finding nothing to migrate.
  const columns = db.all(`PRAGMA table_info(users)`);
  if (!columns.some((col) => col.name === 'totp_secret')) return;

  const legacyUsers = db.all(`SELECT id, totp_secret, totp_enabled FROM users WHERE totp_secret IS NOT NULL`);

  for (const user of legacyUsers) {
    const existing = db.get(`SELECT id FROM authenticators WHERE user_id = ? AND type = 'totp' LIMIT 1`, [user.id]);
    if (existing) continue;

    const result = db.run(
      `INSERT INTO authenticators (user_id, type, status, name) VALUES (?, 'totp', ?, 'Migrated authenticator')`,
      [user.id, user.totp_enabled ? 'active' : 'pending']
    );
    db.run(`INSERT INTO totp_credentials (authenticator_id, secret) VALUES (?, ?)`, [
      result.lastInsertRowid,
      user.totp_secret,
    ]);
  }
}
