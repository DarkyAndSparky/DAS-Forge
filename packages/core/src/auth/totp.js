import { generateSecret, generateSync, verifySync, generateURI, createGuardrails } from 'otplib';

/**
 * RFC 6238 TOTP (§4.5h item 8) on top of `otplib` (HMAC-SHA1, 6 digits -
 * the Google Authenticator defaults). The HMAC, base32 and comparison are
 * otplib's; this file only adapts it to the module's stable API
 * (`at` in unix SECONDS, `stepSeconds`, a +/- `window` of steps) and keeps
 * the "which step matched" result the replay protection needs.
 * Verified against the RFC 6238 test vectors in test/totp-rfc6238.test.js.
 */

const DEFAULT_STEP_SECONDS = 30;

// otplib refuses secrets under 16 bytes by default. Secrets already enrolled
// before the library swap (legacy 10-byte / 16-char base32, the old Google
// Authenticator size) must keep verifying, so only the minimum is lowered.
// New secrets are still generated at 20 bytes.
const guardrails = createGuardrails({ MIN_SECRET_BYTES: 10 });

/** Generates a new random base32 TOTP secret (20 bytes = 160 bits). */
export function generateTotpSecret() {
  return generateSecret();
}

/**
 * Generates the current 6-digit TOTP code for a secret.
 * @param {string} secret - base32-encoded secret
 * @param {object} [opts]
 * @param {number} [opts.stepSeconds=30]
 * @param {number} [opts.at] - unix seconds to generate for (defaults to now; test hook)
 */
export function generateTotp(secret, { stepSeconds = DEFAULT_STEP_SECONDS, at } = {}) {
  return generateSync({ secret, guardrails, period: stepSeconds, ...(at !== undefined ? { epoch: at } : {}) });
}

/**
 * Verifies a user-supplied 6-digit code against the secret, tolerating
 * clock drift via a +/- window of steps (default 1 = accepts the
 * previous/current/next 30s window, i.e. up to ~30-60s of drift).
 */
export function verifyTotp(secret, token, opts = {}) {
  return matchTotpStep(secret, token, opts) !== null;
}

/**
 * Like verifyTotp() but returns WHICH time step matched (or null). The
 * step number is what a caller stores to refuse the same code twice
 * (RFC 6238 §5.2 - audit A07).
 */
export function matchTotpStep(secret, token, { stepSeconds = DEFAULT_STEP_SECONDS, window = 1, at } = {}) {
  if (typeof token !== 'string' || !/^\d{6}$/.test(token)) return null;
  const result = verifySync({
    secret,
    guardrails,
    token,
    period: stepSeconds,
    // otplib's tolerance is in seconds: `window` whole steps either side.
    epochTolerance: window * stepSeconds,
    ...(at !== undefined ? { epoch: at } : {}),
  });
  return result.valid ? result.timeStep : null;
}

/**
 * Builds an otpauth:// URL for QR-code provisioning in an authenticator
 * app (Google Authenticator, Authy, etc.).
 */
export function buildTotpUri(secret, { accountName, issuer = 'DAS-Forge', stepSeconds = DEFAULT_STEP_SECONDS }) {
  return generateURI({
    issuer,
    label: accountName,
    secret,
    ...(stepSeconds !== DEFAULT_STEP_SECONDS ? { period: stepSeconds } : {}),
  });
}
