import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { countUsers, createUser } from './users.js';
import { hashPassword } from './password.js';

/**
 * Generates a readable-but-strong temp password (not base64 - avoids
 * ambiguous characters and is easier to read off a console/log line).
 */
function generateTempPassword(length = 24) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * First-run bootstrap (per architecture doc): if zero users exist,
 * auto-generates an admin account with a random temp password, prints
 * it ONCE (caller decides where - console/log), and flags
 * mustChangePassword=true so nothing else works until it's changed.
 *
 * Idempotent in the sense that it's a no-op once any user exists -
 * `app user create-admin --temp` CLI command remains the manual
 * fallback for recovery scenarios (lost access, not first run).
 *
 * @returns {{created: boolean, username?: string, tempPassword?: string}}
 */
export async function firstRunBootstrap(db, { username = 'admin', argon2Options } = {}) {
  if (countUsers(db) > 0) {
    return { created: false };
  }

  const tempPassword = generateTempPassword(24); // first-run admin password: 24 characters
  const passwordHash = await hashPassword(tempPassword, argon2Options);

  createUser(db, {
    username,
    passwordHash,
    role: 'admin',
    mustChangePassword: true,
  });

  return { created: true, username, tempPassword };
}

/**
 * Writes the first-run credentials to a file readable only by the owner
 * (mode 0600, fails if the file already exists) instead of printing the
 * password to stdout/container logs (audit A16). Returns the file path.
 * Note: POSIX mode is advisory on Windows.
 */
export function writeBootstrapCredentials(file, { username, tempPassword }) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `username: ${username}\ntemp password: ${tempPassword}\n\nChange the password at first login, then delete this file.\n`,
    { flag: 'wx', mode: 0o600 }
  );
  return file;
}
