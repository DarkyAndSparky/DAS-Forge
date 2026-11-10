/**
 * AuthProvider is a BEHAVIORAL interface, not data — per §7.5
 * deliberately not a Zod schema. Duck-typing assertion, called once at
 * app startup.
 */
const REQUIRED_METHODS = [
  'hashPassword',
  'verifyPassword',
];

export function assertAuthProvider(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new TypeError('AuthProvider must be an object');
  }
  const missing = REQUIRED_METHODS.filter((m) => typeof candidate[m] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(
      `Object does not satisfy AuthProvider contract — missing method(s): ${missing.join(', ')}`
    );
  }
  return candidate;
}
