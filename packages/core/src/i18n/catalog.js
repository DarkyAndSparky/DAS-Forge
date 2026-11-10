/**
 * Every text the core itself shows, as i18n namespaces `{ ru: {...}, en: {...} }`.
 * The texts still live next to the code that renders them; this file is the one place that lists them,
 * so a completeness check (and an app that wants to override a core text) sees all of them.
 *
 * Imported on demand (`i18n.coreNamespaces()`), because it pulls in the admin, policy and email modules.
 */
import { AUDIT_SECURITY_TEXTS } from '../admin/sections.js';
import { OPS_TEXTS } from '../admin/sections-ops.js';
import { APPEARANCE_TEXTS } from '../admin/sections-appearance.js';
import { OVERVIEW_TEXTS } from '../admin/index.js';
import { POLICY_UI_TEXTS } from '../policy/index.js';
import { DEFAULT_TEXTS } from '../policy/defaults.js';
import { ERROR_CATALOG } from '../http/error-catalog.js';
import { EMAIL_TEXTS } from '../email/templates.js';
import { UI_TEXTS } from '../ui/texts.js';
import { PASSWORD_TEXTS } from '../admin/sections-password.js';
import { INCIDENT_TEXTS } from '../admin/sections-incidents.js';
import { REGISTRY_TEXTS } from '../admin/sections-registry.js';
import { BROADCAST_TEXTS } from '../admin/sections-broadcast.js';
import { ALERT_TEXTS } from '../admin/sections-alerts.js';
import { ACCOUNT_TEXTS } from '../accounts/texts.js';
import { SYSTEM_TEXTS } from '../admin/sections-system.js';

/** @returns {Record<string, {ru: object, en: object}>} */
export function coreNamespaces() {
  return {
    'admin-overview': OVERVIEW_TEXTS,
    'admin-audit': AUDIT_SECURITY_TEXTS,
    'admin-ops': OPS_TEXTS,
    'admin-alerts': ALERT_TEXTS,
    'admin-password': PASSWORD_TEXTS,
    'admin-incidents': INCIDENT_TEXTS,
    'admin-registry': REGISTRY_TEXTS,
    'admin-broadcast': BROADCAST_TEXTS,
    'admin-system': SYSTEM_TEXTS,
    'admin-appearance': APPEARANCE_TEXTS,
    'policy-ui': POLICY_UI_TEXTS,
    'policy-defaults': DEFAULT_TEXTS,
    accounts: ACCOUNT_TEXTS,
    errors: ERROR_CATALOG,
    email: EMAIL_TEXTS,
    ui: UI_TEXTS,
  };
}
