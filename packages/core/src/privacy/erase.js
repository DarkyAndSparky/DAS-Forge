const VALID_MODES = new Set(['anonymize', 'delete']);

/**
 * §4.5k's `privacy.eraseUserData(userId, { mode })`. Defaults to
 * `'anonymize'`, NEVER `'delete'` - "потому что audit log обязан
 * сохранять целостность истории событий... жёсткое удаление сломало бы
 * аудит". `'delete'` must be passed explicitly by the caller (the CLI
 * command and any future admin-panel button both require their own
 * explicit confirmation before ever reaching this function with
 * `mode: 'delete'` - this function itself does not re-confirm, it
 * trusts the caller already did).
 *
 * Every registered module's `dataSubject.erase(userId, { mode })` runs
 * BEFORE the user record itself is touched - a module's own erase
 * might reasonably need to read the still-intact user record (e.g. to
 * log which org the now-erased assets belonged to), so core/privacy
 * doesn't anonymize/delete the account out from under it first.
 *
 * @param {object} opts
 * @param {import('../database/adapter.js')} opts.db
 * @param {(db, id:number) => object|null} opts.findUserByIdFn - core/auth's findUserById
 * @param {(db, id:number) => object|null} opts.anonymizeUserFn - core/auth's anonymizeUser
 * @param {(db, id:number) => boolean} opts.deleteUserFn - core/auth's deleteUser
 * @param {{getDataSubjectHandlers: () => Array}} opts.moduleRegistry
 * @param {number} opts.userId
 * @param {'anonymize'|'delete'} [opts.mode='anonymize']
 * @param {(db, entry:object) => void} [opts.auditLogFn]
 * @param {(db, opts:{usernames:string[]}) => object} [opts.eraseAuditSubjectsFn] - core/audit's eraseSubjects:
 *   deletes the login/IP pseudonym mappings so the (append-only) audit trail no longer identifies the person
 * @param {{record: Function}} [opts.erasureLedger] - createErasureLedger(): remembers the erase outside the database so a
 *   later `backup restore` can re-apply it (audit F08)
 * @param {string|null} [opts.actor]
 */
export async function eraseUserData({
  db,
  findUserByIdFn,
  anonymizeUserFn,
  deleteUserFn,
  moduleRegistry,
  userId,
  mode = 'anonymize',
  auditLogFn,
  eraseAuditSubjectsFn,
  erasureLedger,
  actor = null,
}) {
  if (!VALID_MODES.has(mode)) {
    throw new TypeError(`eraseUserData: mode must be 'anonymize' or 'delete', got: ${mode}`);
  }

  const user = findUserByIdFn(db, userId);
  if (!user) {
    throw new Error(`No user with id ${userId}`);
  }

  const moduleResults = {};
  for (const handler of moduleRegistry.getDataSubjectHandlers()) {
    try {
      await handler.erase(userId, { mode });
      moduleResults[handler.moduleId] = 'ok';
    } catch (err) {
      // A module that fails to erase its own data is a real problem
      // the operator needs to see and follow up on manually - NOT
      // something to hide behind an overall "success" result, and NOT
      // a reason to also skip erasing the other modules' data.
      moduleResults[handler.moduleId] = `error: ${err.message}`;
    }
  }

  // Before the account changes: the audit trail knows the person by this login.
  let auditSubjects = null;
  if (eraseAuditSubjectsFn) {
    try {
      auditSubjects = eraseAuditSubjectsFn(db, { usernames: [user.username].filter(Boolean) });
    } catch (err) {
      auditSubjects = `error: ${err.message}`;
    }
  }

  const erased = mode === 'delete' ? deleteUserFn(db, userId) : Boolean(anonymizeUserFn(db, userId));
  if (erased && erasureLedger) {
    try { erasureLedger.record({ userId, username: user.username, mode }); } catch { /* the erase itself already happened */ }
  }

  if (auditLogFn) {
    // Logged regardless of per-module outcome above - the request and
    // the account-level action both happened and belong in the trail;
    // per-module failures are in the returned result for the caller to
    // act on, not hidden from the audit entry's result status.
    auditLogFn(db, {
      actor,
      action: 'privacy.erase',
      entity: 'user',
      entityId: userId,
      result: erased ? 'success' : 'failure',
      meta: { mode, moduleResults, auditSubjects },
    });
  }

  return { erasedAt: new Date().toISOString(), userId, mode, accountErased: erased, moduleResults, auditSubjects };
}
