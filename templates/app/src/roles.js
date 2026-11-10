/** The roles this application knows. The CLI, the admin page and the API all validate against this one list. */
export const ROLES = ['admin', 'user'];
export const ADMIN_ROLE = 'admin';

/**
 * What each role may do. Check permissions on the server (`http.requirePermission`), never only hide a button.
 * `admin.access` opens the admin panel (/admin).
 */
export function permissionsForRole(role) {
  return role === 'admin' ? ['read:notes', 'write:notes', 'admin.access', 'admin:write'] : ['read:notes'];
}
