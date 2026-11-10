import os from 'node:os';

/**
 * Who a console command acts as in the audit trail: `cli/<operating-system user>` (for example `cli/deploy`), so that a change made
 * from a terminal can be traced to the account that opened it. The name is stored the way every other person's name is: as a
 * pseudonym that can be erased. Falls back to plain `cli` when the system cannot tell.
 * @param {() => {username: string}} [userInfo] - injectable for tests
 */
export function cliActor(userInfo = os.userInfo) {
  try {
    const name = String(userInfo().username ?? '').replace(/[^\p{L}\p{N}._@-]/gu, '').slice(0, 48);
    return name ? `cli/${name}` : 'cli';
  } catch {
    return 'cli';
  }
}
