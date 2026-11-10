const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Throws unless `name` is a plain SQL identifier (letters, digits, _). */
export function assertSafeIdentifier(name, kind = 'identifier') {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new TypeError(`Unsafe ${kind} identifier: ${JSON.stringify(name)}`);
  }
}

export const MAX_QUERY_LIMIT = 1000;

/**
 * Coerces a caller-supplied LIMIT into an integer in [1, max]
 * (audit B08: `'abc'` used to become `LIMIT NaN`, a negative number
 * meant "no limit"). Non-numeric / non-positive input falls back to
 * `fallback`.
 */
export function normalizeLimit(value, { fallback = 20, max = MAX_QUERY_LIMIT } = {}) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}
