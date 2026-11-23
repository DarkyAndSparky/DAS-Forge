import { randomInt } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

import { countUsers, createUser, findUserByUsername } from './users.js';
import { hashPassword } from './password.js';

/**
 * Generates a readable-but-strong temp password (not base64 - avoids
 * ambiguous characters and is easier to read off a console/log line).
 */
function generateTempPassword(length = 24) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)]; // randomInt draws without modulo bias
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
 * @returns {Promise<{created: boolean, username?: string, tempPassword?: string}>}
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

/**
 * Whether the start banner may print the temporary password. A console line cannot be taken back once it is in a
 * terminal history or a container log, so by default it is printed only into an interactive terminal; anywhere
 * else (a service, `docker logs`) only the path of the credentials file is shown. `DAS_BOOTSTRAP_PRINT=true`
 * forces printing, `false` forbids it.
 * @param {Record<string, string | undefined>} env
 * @param {{isTTY?: boolean}} stdout
 */
export function bootstrapPrintAllowed(env = process.env, stdout = process.stdout) {
  const v = String(env.DAS_BOOTSTRAP_PRINT ?? '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return Boolean(stdout?.isTTY);
}

/**
 * Removes the first-run credentials file once the administrator has changed the temporary password
 * (the user no longer has `mustChangePassword`). A file that is not there, or a password still to be
 * changed, is left alone.
 * @returns {'removed' | 'kept' | 'none'}
 */
export function removeBootstrapCredentialsIfChanged(db, file, { username = 'admin' } = {}) {
  if (!existsSync(file)) return 'none';
  const user = findUserByUsername(db, username);
  if (!user || user.mustChangePassword) return 'kept';
  try { rmSync(file, { force: true }); return 'removed'; } catch { return 'kept'; }
}

/**
 * Checks now and then (default every 30 s, the timer does not keep the process alive) and removes the
 * credentials file as soon as the temporary password has been changed. Returns `stop()`.
 * @param {{username?: string, intervalMs?: number, onRemoved?: () => void}} [o]
 */
export function watchBootstrapCredentials(db, file, { username = 'admin', intervalMs = 30_000, onRemoved } = {}) {
  let timer = null;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  const tick = () => {
    let r;
    try { r = removeBootstrapCredentialsIfChanged(db, file, { username }); } catch { r = 'kept'; }
    if (r === 'removed') { stop(); try { onRemoved?.(); } catch { /* a faulty callback must not stop the cleanup */ } } else if (r === 'none') stop();
  };
  tick();
  if (existsSync(file)) { timer = setInterval(tick, intervalMs); timer.unref?.(); }
  return stop;
}
