import { readFileSync, existsSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

/**
 * §4.5f's `app cert info` - "срок действия, subjectAltName, self-signed
 * или нет". Deliberately pure `node:crypto` (available since Node 15.6,
 * well under this project's >=26 floor) - reading and parsing an
 * EXISTING certificate needs no third-party library at all, unlike
 * generating a new one (generate.js, which does need `selfsigned` for
 * the actual X.509 construction). Keeping this file dependency-free
 * also means `cert info`/the doctor check (doctor-check.js) work even
 * in an environment where `selfsigned` somehow isn't installed - the
 * read path and the generate path have no reason to share a failure
 * mode.
 *
 * Self-signed detection uses `X509Certificate.checkIssued(self)`
 * (does this cert's signature verify against its OWN public key) -
 * the actually-correct check, not the common but technically-looser
 * "issuer string equals subject string" heuristic.
 *
 * @returns {{
 *   subject: string, issuer: string, selfSigned: boolean,
 *   validFrom: Date, validTo: Date, daysRemaining: number,
 *   subjectAltName: string|null, serialNumber: string
 * }}
 */
export function readCertInfo(certPath) {
  if (!existsSync(certPath)) {
    throw new Error(`No certificate at ${certPath}`);
  }

  const cert = new X509Certificate(readFileSync(certPath));
  const now = Date.now();
  const daysRemaining = Math.floor((cert.validToDate.getTime() - now) / (24 * 60 * 60 * 1000));

  return {
    subject: cert.subject,
    issuer: cert.issuer,
    selfSigned: cert.checkIssued(cert),
    validFrom: cert.validFromDate,
    validTo: cert.validToDate,
    daysRemaining,
    subjectAltName: cert.subjectAltName ?? null,
    serialNumber: cert.serialNumber,
  };
}
