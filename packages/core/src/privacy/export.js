/**
 * §4.5k: "the subject of the data is an employee, the request is
 * usually initiated by an admin/HR, not the employee themselves" - this
 * is the `privacy.exportUserData(userId)` side of that: collects the
 * user's own core/auth record plus every registered module's
 * `dataSubject.export(userId)` result into one JSON-serializable object.
 *
 * core/privacy never imports a module directly - it only ever sees what
 * `moduleRegistry.getDataSubjectHandlers()` (core/modules) hands back,
 * same boundary as everywhere else in this codebase (§1).
 *
 * @param {object} opts
 * @param {import('../database/adapter.js')} opts.db
 * @param {(db, id:number) => object|null} opts.findUserByIdFn - core/auth's findUserById
 * @param {{getDataSubjectHandlers: () => Array}} opts.moduleRegistry
 * @param {number} opts.userId
 * @param {(db, entry:object) => void} [opts.auditLogFn] - core/audit's log(), optional
 * @param {(db, filters:object) => Array} [opts.auditQueryFn] - core/audit's query(): the person's audit entries are included
 * @param {(db, userId:number) => Array} [opts.listAuthenticatorsFn] - core/auth's listAuthenticators()
 * @param {string|null} [opts.actor] - who requested the export, for the audit entry
 */
export async function exportUserData({ db, findUserByIdFn, moduleRegistry, userId, auditLogFn, auditQueryFn, listAuthenticatorsFn, actor = null }) {
  const user = findUserByIdFn(db, userId);
  if (!user) {
    throw new Error(`No user with id ${userId}`);
  }

  const modules = {};
  for (const handler of moduleRegistry.getDataSubjectHandlers()) {
    // One module's export() throwing shouldn't hide every other
    // module's data - the operator needs the rest of the export even
    // if one module's data source is temporarily unavailable. The
    // failure is recorded in the output itself, not swallowed silently.
    try {
      modules[handler.moduleId] = await handler.export(userId);
    } catch (err) {
      modules[handler.moduleId] = { error: err.message };
    }
  }

  // Core-owned data about the person (audit F06): sessions (no ids/cookies), sign-in factors (no secrets), audit entries.
  const core = {};
  try {
    core.sessions = db
      .all(`SELECT created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 500`, [userId])
      .map((s) => ({ createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at }));
  } catch (err) { core.sessions = { error: err.message }; }
  if (listAuthenticatorsFn) {
    try {
      core.authenticators = listAuthenticatorsFn(db, userId).map((a) => ({ type: a.type, status: a.status, label: a.label ?? null, createdAt: a.createdAt ?? a.created_at ?? null }));
    } catch (err) { core.authenticators = { error: err.message }; }
  }
  if (auditQueryFn) {
    try {
      const entries = [];
      let beforeId;
      while (entries.length < 5000) {
        const batch = auditQueryFn(db, { actor: user.username, beforeId, limit: 1000 });
        entries.push(...batch);
        if (batch.length < 1000) break;
        beforeId = batch[batch.length - 1].id;
      }
      core.audit = entries.map((e) => ({ id: e.id, createdAt: e.createdAt, action: e.action, entity: e.entity, entityId: e.entityId, result: e.result, ip: e.ip, meta: e.meta }));
    } catch (err) { core.audit = { error: err.message }; }
  }

  const result = {
    exportedAt: new Date().toISOString(),
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    },
    core,
    modules,
  };

  if (auditLogFn) {
    // The request itself is part of the audit trail, per §4.5k - "сам
    // факт запроса на приватность тоже часть аудита", not just the
    // outcome.
    auditLogFn(db, { actor, action: 'privacy.export', entity: 'user', entityId: userId });
  }

  return result;
}
