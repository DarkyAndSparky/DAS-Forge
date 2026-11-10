/**
 * Security category - deliberately scoped to what core actually
 * implements today (auth.sessionSecret, server.https.mode). The
 * architecture doc's full §4.5 matrix also lists certificate expiry
 * and LDAP/SMTP reachability under Security/Integrations, but
 * core/certs and core/ldap/core/email don't exist yet - this file adds
 * those checks when those modules land, per the doc's own design
 * ("each module adds its own check without changing the doctor
 * framework"), not by stubbing checks for infrastructure that isn't
 * there.
 */
import { KNOWN_PLACEHOLDER_SECRETS } from '../../config/secrets.js';
import { resolveRedirectPort } from '../../http/server.js';

/**
 * @param appConfig - the loaded, validated ApplicationConfig
 */
export function securityChecks(appConfig, { now = () => Date.now() } = {}) {
  const results = [];
  results.push(...secretAgeChecks(appConfig, now));
  if (appConfig?.env === 'production' && appConfig?.security?.stepUp && !appConfig.security.stepUp.enabled) {
    results.push({ name: 'Step-up confirmation', status: 'warn', message: 'dangerous administration actions run without a fresh confirmation (security.stepUp.enabled is false)' });
  }

  // The log is deleted after audit.retentionDays; when its copy outside the database is minimal and there is no archive,
  // the history is gone for good (audit R-14).
  if (appConfig?.env === 'production' && appConfig?.audit && appConfig.audit.retentionDays > 0 && !appConfig.audit.archiveDir && (appConfig.logging?.auditMirror ?? 'minimal') !== 'full') {
    results.push({ name: 'Audit archive', status: 'warn', message: `audit rows older than ${appConfig.audit.retentionDays} days are deleted and no archive is configured (audit.archiveDir) and the log mirror is not full - the history will be lost` });
  }

  const secret = appConfig?.auth?.sessionSecret ?? '';
  if (secret.length < 16) {
    results.push({
      name: 'Session secret',
      status: 'fail',
      message: 'auth.sessionSecret is missing or shorter than 16 characters',
    });
  } else if (KNOWN_PLACEHOLDER_SECRETS.has(secret.toLowerCase())) {
    results.push({
      name: 'Session secret',
      status: 'fail',
      message: 'auth.sessionSecret is a known placeholder value - replace it before going live',
    });
  } else {
    results.push({ name: 'Session secret', status: 'ok', message: 'configured, not a known placeholder' });
  }

  const httpsMode = appConfig?.server?.https?.mode ?? 'self-signed';
  if (httpsMode === 'self-signed' && appConfig?.env === 'production') {
    results.push({
      name: 'HTTPS mode',
      status: 'warn',
      message: `self-signed in production - fine for internal tools, confirm this is intentional`,
    });
  } else {
    results.push({ name: 'HTTPS mode', status: 'ok', message: httpsMode });
  }

  const server = appConfig?.server;
  if (server) {
    const redirect = resolveRedirectPort(server);
    if (httpsMode === 'reverse-proxy') {
      results.push({ name: 'HTTP to HTTPS', status: 'ok', message: 'behind a reverse proxy: the proxy must redirect port 80 to HTTPS' });
    } else if (redirect === false) {
      results.push({ name: 'HTTP to HTTPS', status: 'warn', message: 'no plain-HTTP redirect listener (server.httpRedirectPort is off): someone typing http:// gets a refused connection instead of a redirect' });
    } else if (redirect === server.port) {
      results.push({ name: 'HTTP to HTTPS', status: 'fail', message: `the redirect port ${redirect} equals the HTTPS port` });
    } else {
      results.push({ name: 'HTTP to HTTPS', status: 'ok', message: `http on ${redirect} redirects to https on ${server.port}` });
    }
  }

  return results;
}

/**
 * Age of the long-lived keys (audit R-19). Only keys that are configured are checked; a key without a recorded creation date
 * is reported as "unknown" (ok): the date is a convention the administrator opts into (`security.secretsRotation.*CreatedAt`).
 */
function secretAgeChecks(appConfig, now) {
  const rot = appConfig?.security?.secretsRotation;
  if (!rot) return [];
  const maxAge = rot.maxAgeDays ?? 365;
  const keys = [
    ['Session secret age', appConfig?.auth?.sessionSecret, rot.sessionSecretCreatedAt],
    ['TOTP key age', appConfig?.auth?.totpEncryptionKey, rot.totpKeyCreatedAt],
    ['Backup key age', appConfig?.backup?.encryptionKey, rot.backupKeyCreatedAt],
  ];
  const out = [];
  for (const [name, value, created] of keys) {
    if (!value) continue; // not configured: nothing to rotate
    if (!created) { out.push({ name, status: 'ok', message: 'creation date not recorded (security.secretsRotation)' }); continue; }
    const days = Math.floor((now() - new Date(`${created}T00:00:00Z`).getTime()) / 86_400_000);
    out.push(days > maxAge
      ? { name, status: 'warn', message: `${days} days old (more than ${maxAge}) - rotate the key` }
      : { name, status: 'ok', message: `${days} days old` });
  }
  return out;
}
