import { sendError } from './respond.js';
// Sessions themselves come from express-session (`http.createSessionMiddleware`), and
// `http.attachUser()` is the ONLY place req.user is set (zero-trust, §4.5j): permissions
// are read from there, never from a body, header or query parameter. The guards below
// do not authenticate by themselves - they only refuse requests with no req.user.

export function requireAuth() {
  return (req, res, next) => {
    if (!req.user) {
      return sendError(req, res, 401, { error: 'UNAUTHENTICATED', fields: [] });
    }
    next();
  };
}

/** req.user.permissions must be populated by the app's login flow. */
export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return sendError(req, res, 401, { error: 'UNAUTHENTICATED', fields: [] });
    }
    const perms = req.user.permissions instanceof Set
      ? req.user.permissions
      : new Set(req.user.permissions ?? []);
    if (!perms.has(permission)) {
      return sendError(req, res, 403, { error: 'FORBIDDEN', fields: [] });
    }
    next();
  };
}
