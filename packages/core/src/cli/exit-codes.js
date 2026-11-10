/**
 * CLI exit-code convention (audit C09):
 *   0 OK            - success
 *   1 FAILURE       - the command ran and failed / refused (unknown command, missing --yes/--force, not found, runtime error)
 *   2 USAGE         - the command was invoked wrongly (missing required argument or flag)
 *   3 CHECK_FAILED  - a health/verification check ran and reported problems (doctor)
 */
export const EXIT = Object.freeze({ OK: 0, FAILURE: 1, USAGE: 2, CHECK_FAILED: 3 });
