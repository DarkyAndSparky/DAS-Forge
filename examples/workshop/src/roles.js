/** The roles this app knows. The CLI, the admin API and the admin page all validate against this one list. */
/** `auditor` reads the audit log and exports it, and sees nothing else of the administration. */
/** `viewer` only reads the pages the app marks as readable (`read:basic`): no changes, no administration. */
export const ROLES = ['admin', 'operator', 'auditor', 'viewer'];
export const ADMIN_ROLE = 'admin';
