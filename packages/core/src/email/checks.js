import { checkMailDomainDns } from './dns-check.js';

/** `Name <a@b.co>` or `a@b.co` -> `b.co` (null when there is no usable address). */
export function senderDomain(from) {
  const m = String(from ?? '').match(/<([^<>\s]+)>\s*$/) ?? String(from ?? '').match(/^\s*([^<>\s]+)\s*$/);
  const domain = m?.[1]?.split('@')[1]?.toLowerCase();
  return domain && domain.includes('.') ? domain : null;
}

/**
 * Doctor checks for the "Integrations" category: is the mail setup usable
 * and trustworthy. Never throws; a disabled mailer is reported as fine
 * (it is a choice, not a fault).
 *
 * @param {object} config - appConfig.email
 * @param {{verify: Function}} service - from createEmailService
 * @param {{resolver?: object}} [opts] - DNS resolver for tests
 * @returns {Promise<Array<{name: string, status: 'ok'|'warn'|'fail', message: string}>>}
 */
export async function emailChecks(config, service, { resolver } = {}) {
  if (!config?.enabled) return [{ name: 'E-mail', status: 'ok', message: 'disabled (email.enabled is false)' }];

  const results = [];
  const smtp = config.smtp ?? {};

  const verified = await service.verify();
  results.push(
    verified.ok
      ? { name: 'SMTP reachable', status: 'ok', message: `${smtp.host}:${smtp.port ?? 587}` }
      : { name: 'SMTP reachable', status: 'fail', message: `${smtp.host}:${smtp.port ?? 587} - ${verified.error}` }
  );

  if (smtp.rejectUnauthorized === false) {
    results.push({ name: 'SMTP certificate check', status: 'warn', message: 'smtp.rejectUnauthorized is false: the server certificate is not verified' });
  }
  if (!smtp.secure && smtp.requireTLS === false) {
    results.push({ name: 'SMTP encryption', status: 'warn', message: 'smtp.requireTLS is false: credentials and mail may travel unencrypted' });
  }

  const domain = senderDomain(config.from);
  if (!domain) {
    results.push({ name: 'Sender domain', status: 'warn', message: `cannot find a domain in email.from (${config.from})` });
    return results;
  }
  try {
    const dns = await checkMailDomainDns(domain, resolver ? { resolver } : undefined);
    if (dns.warnings.length === 0) results.push({ name: 'SPF/DMARC', status: 'ok', message: `${domain}: SPF and DMARC are published` });
    for (const w of dns.warnings) results.push({ name: 'SPF/DMARC', status: 'warn', message: w });
  } catch (err) {
    results.push({ name: 'SPF/DMARC', status: 'warn', message: `could not check DNS for ${domain} (${err.code ?? err.message})` });
  }
  return results;
}
