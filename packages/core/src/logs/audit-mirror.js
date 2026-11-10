/**
 * Sends the audit trail to the log destination as well (stream `audit`), so a copy exists
 * somewhere an intruder on the application host cannot reach once the sinks point off-machine.
 *
 * mode:
 *  - 'minimal' (default): id, hash, prevHash, action, result, time - no actor, IP or details, so no
 *    personal data leaves the host, yet any changed, deleted or truncated row is detectable by
 *    comparing `id -> hash` with the database (`audit verify --anchor-id/--anchor-hash`);
 *  - 'full': the complete entry (actor, entity, ip, meta - already stripped of secrets);
 *  - 'off'.
 *
 * @param {(fn: Function) => () => void} subscribe - core/audit's `onEntry`
 * @param {{child: Function}} logger
 * @returns {() => void} unsubscribe
 */
export function mirrorAuditToLogs(subscribe, logger, { mode = 'minimal' } = {}) {
  if (mode === 'off') return () => {};
  const log = logger.child({ stream: 'audit' });
  return subscribe(({ entry, hash, prevHash }) => {
    if (mode === 'full') {
      log.info('audit', { event: 'audit.entry', ...entry, hash, prevHash });
    } else {
      log.info('audit', { event: 'audit.entry', id: entry.id, hash, prevHash, action: entry.action, result: entry.result, createdAt: entry.createdAt });
    }
  });
}

/** Writes the current chain head to the log stream `audit`: the reference `audit verify` is later checked against. */
export function logAuditAnchor(anchorFn, db, logger) {
  const a = anchorFn(db);
  if (!a) return null;
  logger.child({ stream: 'audit' }).info('audit anchor', { event: 'audit.anchor', anchorId: a.id, anchorHash: a.hash, count: a.count });
  return a;
}
