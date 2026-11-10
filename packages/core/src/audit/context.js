/**
 * Derives the {actor, requestId, ip} triple that most log() calls from
 * an HTTP handler need, from an Express `req` already processed by
 * core/http's requestId() and sessionMiddleware(). This is the concrete
 * reason audit lives as its own module rather than inside core/auth or
 * core/http (§11 of the architecture doc): it reads fields set by both.
 *
 * req.user is deliberately read defensively (optional chaining) - this
 * must work for anonymous requests too (e.g. logging a failed login
 * attempt, where there is no req.user yet).
 *
 * Usage: audit.log(db, { ...audit.contextFromRequest(req), action: 'auth.login', result: 'failure' })
 */
export function contextFromRequest(req) {
  return {
    actor: req?.user?.username ?? null,
    requestId: req?.id ?? null,
    ip: req?.ip ?? null,
  };
}
