import dns from 'node:dns/promises';

/**
 * SPF/DMARC are DNS records the operator publishes - core cannot create them,
 * but it can notice they are missing (roadmap §4.5e): without them a password
 * reset mail from this system is easy to forge and easy to lose in spam.
 *
 * @param {string} domain - the domain the mail is sent from (right side of `from`)
 * @param {{resolver?: {resolveTxt: (name: string) => Promise<string[][]>}}} [opts]
 * @returns {Promise<{domain: string, spf: object, dmarc: object, warnings: string[]}>}
 */
export async function checkMailDomainDns(domain, { resolver = dns } = {}) {
  const txt = async (name) => {
    try {
      return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
    } catch (err) {
      if (['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(err.code)) return [];
      throw err;
    }
  };

  const spfRecord = (await txt(domain)).find((r) => /^v=spf1(\s|$)/i.test(r)) ?? null;
  const dmarcRecord = (await txt(`_dmarc.${domain}`)).find((r) => /^v=DMARC1\b/i.test(r)) ?? null;
  const spfAll = spfRecord?.match(/\s([-~?+])all\b/i)?.[1] ?? null;
  const dmarcPolicy = dmarcRecord?.match(/(?:^|;)\s*p\s*=\s*(none|quarantine|reject)/i)?.[1]?.toLowerCase() ?? null;

  const warnings = [];
  if (!spfRecord) warnings.push(`SPF record is missing for ${domain}`);
  else if (spfAll === '+' || spfAll === '?' || spfAll === null) warnings.push(`SPF for ${domain} does not end with -all or ~all (anyone may be allowed to send)`);
  if (!dmarcRecord) warnings.push(`DMARC record is missing for ${domain} (recommended: p=quarantine at least)`);
  else if (dmarcPolicy === 'none' || dmarcPolicy === null) warnings.push(`DMARC policy for ${domain} is "${dmarcPolicy ?? 'unset'}" (recommended: quarantine or reject)`);

  return {
    domain,
    spf: { found: Boolean(spfRecord), record: spfRecord, all: spfAll },
    dmarc: { found: Boolean(dmarcRecord), record: dmarcRecord, policy: dmarcPolicy },
    warnings,
  };
}
