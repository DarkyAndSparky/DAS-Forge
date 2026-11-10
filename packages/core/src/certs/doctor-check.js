import { existsSync } from 'node:fs';
import { readCertInfo } from './info.js';

/**
 * core/health's §11b writeup explicitly deferred this: "Чего нет
 * сознательно: Integrations/сертификаты из полной §4.5-матрицы - ждут
 * несуществующих пока core/email/core/ldap/core/certs". core/certs now
 * exists, so this closes that gap - a doctor CATEGORY PROVIDER (same
 * shape as runtimeChecks/databaseChecks/etc. in core/health/checks/),
 * meant to be added to an app's `categoryProviders` list (bin/app.js)
 * alongside the built-in ones, exactly like the doc's own sample doctor
 * output showed ("✓ certificates valid (expires in 214 days)" under
 * Security).
 *
 * Lives in core/certs, not core/health, because core/health has no
 * reason to know what a certificate is - same module-ownership
 * principle as everywhere else (core/audit owns its own query logic
 * rather than core/health reaching into core/audit's tables directly).
 *
 * @param {string} certPath
 * @param {object} [opts]
 * @param {number} [opts.warnDays=30] - 'warn' once fewer days than this remain
 */
export function certChecks(certPath, { warnDays = 30 } = {}) {
  if (!existsSync(certPath)) {
    return [{ name: 'Certificate', status: 'fail', message: `no certificate at ${certPath} - run \`cert generate\`` }];
  }

  let info;
  try {
    info = readCertInfo(certPath);
  } catch (err) {
    return [{ name: 'Certificate', status: 'fail', message: err.message }];
  }

  const results = [];

  if (info.daysRemaining < 0) {
    results.push({ name: 'Certificate', status: 'fail', message: `expired ${-info.daysRemaining} day(s) ago - run \`cert renew\`` });
  } else if (info.daysRemaining < warnDays) {
    results.push({ name: 'Certificate', status: 'warn', message: `expires in ${info.daysRemaining} day(s) - run \`cert renew\`` });
  } else {
    results.push({ name: 'Certificate', status: 'ok', message: `valid (expires in ${info.daysRemaining} days)` });
  }

  if (info.selfSigned) {
    // Advisory, not a failure - §4.5f's own sample doctor output shows
    // this exact line as a '⚠', and a self-signed cert is the
    // documented DEFAULT for this project's internal tools, not a
    // misconfiguration.
    results.push({ name: 'Certificate trust', status: 'warn', message: 'self-signed - not trusted by default in browsers (see `cert trust`)' });
  }

  return results;
}
