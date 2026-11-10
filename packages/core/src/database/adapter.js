/**
 * DatabaseAdapter is a BEHAVIORAL interface (method set), not data —
 * per §7.5 this is deliberately NOT a Zod schema. It's a lightweight
 * duck-typing assertion called once at app startup.
 */
const REQUIRED_METHODS = [
  'run',
  'get',
  'all',
  'exec',
  'transaction',
  'createFtsIndex',
  'queryByExample',
  'close',
];

export function assertDatabaseAdapter(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new TypeError('DatabaseAdapter must be an object');
  }
  const missing = REQUIRED_METHODS.filter((m) => typeof candidate[m] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(
      `Object does not satisfy DatabaseAdapter contract — missing method(s): ${missing.join(', ')}`
    );
  }
  return candidate;
}
