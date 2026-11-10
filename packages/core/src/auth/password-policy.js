/**
 * Password policy (audit A15). Deliberately NIST-style: length limits and a
 * short deny-list, no "must contain a digit and a symbol" composition rules.
 *
 * The upper bound matters for a different reason than the lower one: the
 * password is fed to argon2 (tens of ms and ~19 MiB of memory per call), so
 * an unbounded password is a cheap way to burn server time.
 *
 * Returns problem CODES (stable strings the UI can translate), never text.
 */

/** Hard ceiling for any password the server will even hash/verify. */
export const PASSWORD_ABSOLUTE_MAX = 1024;

const COMMON = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'qwerty', 'qwerty123', 'qwertyuiop',
  '12345678', '123456789', '1234567890', '11111111', '00000000', '87654321', 'abc12345',
  'iloveyou', 'admin123', 'administrator', 'letmein1', 'welcome1', 'welcome123', 'changeme',
  'changeme123', 'qazwsxedc', '1q2w3e4r', '1qaz2wsx', 'zaq12wsx', 'monkey123', 'dragon123',
  'football1', 'master123', 'sunshine1', 'trustno1', 'p@ssw0rd', 'p@ssword', 'пароль123', 'йцукенгшщзх',
]);

/**
 * @param {string} plain
 * @param {object} [opts]
 * @param {number} [opts.minLength=8]   in characters (code points)
 * @param {number} [opts.maxLength=128] in characters; clamped to PASSWORD_ABSOLUTE_MAX
 * @param {string} [opts.username]      password equal to it (any case) is refused
 * @param {string} [opts.currentPassword] new password equal to it is refused
 * @param {string[]} [opts.forbidden]   extra exact (case-insensitive) values to refuse
 * @param {number} [opts.requireClasses=0] how many of the four character classes (lower, upper, digit, other) must occur, 0..4
 * @param {string[]} [opts.context]     words the password must not contain (login, e-mail name, application name); words under 4 characters are ignored
 * @returns {{ ok: boolean, problems: Array<'NOT_A_STRING'|'TOO_SHORT'|'TOO_LONG'|'SAME_AS_USERNAME'|'SAME_AS_CURRENT'|'COMMON'|'TOO_FEW_CLASSES'|'CONTAINS_CONTEXT'> }}
 */
export function checkPasswordPolicy(plain, { minLength = 8, maxLength = 128, username, currentPassword, forbidden = [], requireClasses = 0, context = [] } = {}) {
  if (typeof plain !== 'string') return { ok: false, problems: ['NOT_A_STRING'] };
  const problems = [];
  const length = [...plain].length;
  if (length < minLength) problems.push('TOO_SHORT');
  if (length > Math.min(maxLength, PASSWORD_ABSOLUTE_MAX)) problems.push('TOO_LONG');
  const lower = plain.toLowerCase();
  if (username && lower === String(username).toLowerCase()) problems.push('SAME_AS_USERNAME');
  if (typeof currentPassword === 'string' && plain === currentPassword) problems.push('SAME_AS_CURRENT');
  if (COMMON.has(lower) || forbidden.some((f) => String(f).toLowerCase() === lower)) problems.push('COMMON');
  if (requireClasses > 0 && characterClasses(plain) < requireClasses) problems.push('TOO_FEW_CLASSES');
  if (!problems.includes('SAME_AS_USERNAME') && context.some((w) => String(w ?? '').length >= 4 && lower.includes(String(w).toLowerCase()))) problems.push('CONTAINS_CONTEXT');
  return { ok: problems.length === 0, problems };
}

/** How many of lower-case letters, upper-case letters, digits and everything else (symbols, spaces) the text uses. */
export function characterClasses(plain) {
  let n = 0;
  if (/\p{Ll}/u.test(plain)) n++;
  if (/\p{Lu}/u.test(plain)) n++;
  if (/\p{Nd}/u.test(plain)) n++;
  if (/[^\p{L}\p{Nd}]/u.test(plain)) n++;
  return n;
}
