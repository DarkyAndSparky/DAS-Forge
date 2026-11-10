/** The roles this app knows. The CLI, the admin API and the admin page all validate against this one list. */
/** `auditor` reads the audit log and exports it, and sees nothing else of the administration. */
export const ROLES = ['admin', 'operator', 'auditor'];
export const ADMIN_ROLE = 'admin';
