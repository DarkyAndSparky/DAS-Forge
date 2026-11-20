import { randomBytes } from 'node:crypto';

/** Secrets that must never reach production (shared by `doctor` and loadConfig). */
export const KNOWN_PLACEHOLDER_SECRETS = new Set([
  'changeme',
  'change-me',
  'secret',
  'password',
  'default',
  '0123456789abcdef',
]);

export function isPlaceholderSecret(secret) {
  const s = String(secret ?? '').toLowerCase();
  return KNOWN_PLACEHOLDER_SECRETS.has(s) || /^(change[-_ ]?me|replace[-_ ]?me|your[-_ ]?secret)/.test(s);
}

/** A new random secret: `bytes` random bytes (default 32), base64url. */
export function generateSecret(bytes = 32) {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) throw new RangeError('bytes must be an integer from 16 to 128');
  return randomBytes(bytes).toString('base64url');
}

/**
 * Whether a secret looks guessable. Not a proof of strength: it refuses what is obviously weak - a known placeholder,
 * a few distinct characters, a repeated short piece ("abcabcabc..."), a run of the keyboard/alphabet, or a low
 * Shannon entropy per character. A value from `generateSecret` always passes.
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkSecretStrength(secret) {
  const s = String(secret ?? '');
  if (isPlaceholderSecret(s)) return { ok: false, reason: 'known placeholder' };
  if (new Set(s).size < 8) return { ok: false, reason: 'fewer than 8 distinct characters' };
  for (let n = 1; n <= Math.floor(s.length / 2); n += 1) {
    if (s.length % n === 0 && s.slice(0, n).repeat(s.length / n) === s) return { ok: false, reason: 'a short piece repeated' };
  }
  const low = s.toLowerCase();
  const runs = ['abcdefghijklmnopqrstuvwxyz', '0123456789', 'qwertyuiopasdfghjklzxcvbnm', 'йцукенгшщзхъфывапролджэячсмитьбю'];
  for (const r of runs) {
    for (let i = 0; i + 8 <= r.length; i += 1) if (low.includes(r.slice(i, i + 8))) return { ok: false, reason: 'contains a run of the alphabet, digits or keyboard' };
  }
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  if (h * s.length < 64) return { ok: false, reason: 'low entropy (under 64 bits by character frequency)' };
  return { ok: true };
}
