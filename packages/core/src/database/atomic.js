/**
 * Runs a synchronous "read, decide, write" sequence as ONE transaction that takes the write lock up front.
 *
 * Without it two processes on the same database file (the server and a CLI command, or two workers) can both read the same
 * state, both decide "this is allowed", and both write: the last administrator is demoted twice, the last second factor is
 * removed twice. With `immediate` the second one waits for the first to commit and then reads the new state. Calls nest
 * (the inner one becomes a savepoint), so it is safe inside another transaction. Everything the function writes either
 * happens together or not at all, which also keeps a crash from leaving a half-applied change.
 *
 * `fn` must be synchronous. An adapter without `transaction` (a minimal stand-in in a test) just runs `fn`.
 *
 * @template T
 * @param {object} db - DatabaseAdapter
 * @param {(db: object) => T} fn
 * @returns {T}
 */
export function atomic(db, fn) {
  return typeof db.transaction === 'function' ? db.transaction(fn, { mode: 'immediate' }) : fn(db);
}
