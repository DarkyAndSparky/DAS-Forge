/**
 * Pause before retry number `attempt` (1 = first retry): exponential growth with "equal jitter".
 *
 * The result lies in [d/2, d] where d = min(maxMs, baseMs * 2^(attempt-1)). The random half spreads out
 * clients that failed at the same moment, so a recovering mail server or log receiver is not hit by all
 * of them at once (retry storm). The lower bound keeps a minimum pause.
 *
 * @param {number} attempt - 1-based number of the retry
 * @param {{baseMs?: number, maxMs?: number, random?: () => number}} [o] - `random` returns [0, 1) (tests pass a fixed one)
 * @returns {number} milliseconds, integer
 */
export function backoffDelay(attempt, { baseMs = 1000, maxMs = Infinity, random = Math.random } = {}) {
  const exp = Math.min(Math.max(0, Math.floor(attempt) - 1), 30);
  const d = Math.min(maxMs, baseMs * 2 ** exp);
  return Math.round(d / 2 + (d / 2) * Math.min(Math.max(random(), 0), 1));
}
