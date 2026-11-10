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
