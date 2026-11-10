import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { flagInt, flagString } from '../arg-parser.js';

const TRUST_INSTRUCTIONS = `To trust this self-signed certificate locally:

Linux (Debian/Ubuntu):
  sudo cp <cert.pem> /usr/local/share/ca-certificates/das-forge.crt
  sudo update-ca-certificates

macOS:
  sudo security add-trusted-cert -d -r trustRoot \\
    -k /Library/Keychains/System.keychain <cert.pem>

Windows (PowerShell, as Administrator):
  Import-Certificate -FilePath <cert.pem> -CertStoreLocation Cert:\\LocalMachine\\Root

Browsers using their own certificate store (Firefox) need the
certificate imported there separately - see the browser's settings.
This only affects THIS machine; it is not a substitute for a real CA
(Let's Encrypt via an external certbot, or an internal CA) for anything
reachable from outside it.`;

/**
 * `app cert {info,generate,renew,trust}` (§4.5f). Same dependency-
 * injection pattern as every other commands/*.js file (backup.js,
 * db.js, audit.js, privacy.js) - this file never imports core/certs
 * itself, it only does argv parsing and console output against
 * functions the caller (bin/app.js) hands it. That keeps `cert info`/
 * `cert trust` usable even in a build where `selfsigned` (only needed
 * by generate/renew) isn't installed - core/certs/generate.js is the
 * only file with a static import of that package, and nothing here
 * forces it to load just to run `cert info`.
 *
 * @param {object} cli
 * @param {object} opts
 * @param {string} opts.certPath
 * @param {string} opts.certDir
 * @param {(certPath: string) => object} opts.readCertInfoFn - core/certs' readCertInfo
 * @param {(opts: object) => Promise<{cert:string, key:string}>} opts.generateCertFn - core/certs' generateSelfSignedCert
 * @param {(certDir: string, pems: object) => {certPath:string, keyPath:string}} opts.writeCertFilesFn - core/certs' writeCertFiles
 * @param {string} [opts.defaultCommonName='localhost']
 */
export function registerCertCommands(cli, { certPath, certDir, readCertInfoFn, generateCertFn, writeCertFilesFn, defaultCommonName = 'localhost' }) {
  cli.command('cert info', {
    description: "Show the current certificate's validity, SAN, and self-signed status",
    handler({ flags }) {
      if (!existsSync(certPath)) {
        // eslint-disable-next-line no-console
        console.error(`No certificate at ${certPath} - run \`cert generate\` first.`);
        return 1;
      }

      const info = readCertInfoFn(certPath);

      if (flags.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(info));
      } else {
        // eslint-disable-next-line no-console
        console.log(`subject: ${info.subject}`);
        // eslint-disable-next-line no-console
        console.log(`subjectAltName: ${info.subjectAltName ?? '(none)'}`);
        // eslint-disable-next-line no-console
        console.log(`self-signed: ${info.selfSigned ? 'yes' : 'no'}`);
        // eslint-disable-next-line no-console
        console.log(
          info.daysRemaining < 0
            ? `✗ expired ${-info.daysRemaining} day(s) ago`
            : `✓ certificate valid (expires in ${info.daysRemaining} days)`
        );
        if (info.selfSigned) {
          // eslint-disable-next-line no-console
          console.log('⚠ self-signed certificate in use - not trusted by default in browsers');
        }
        if (info.daysRemaining >= 0 && info.daysRemaining < 30) {
          // eslint-disable-next-line no-console
          console.log(`⚠ certificate expires in ${info.daysRemaining} days\n    → run \`cert renew\``);
        }
      }
      return info.daysRemaining < 0 ? 1 : 0;
    },
  });

  cli.command('cert generate', {
    description: 'Generate a new self-signed certificate (app cert generate [--force] [--common-name <cn>] [--alt-names a,b] [--days n])',
    async handler({ flags }) {
      if (existsSync(certPath) && flags.force !== true) {
        // eslint-disable-next-line no-console
        console.error(`A certificate already exists at ${certPath}. Re-run with --force to overwrite.`);
        return 1;
      }

      const commonName = flagString(flags, 'common-name') || defaultCommonName;
      const altNames = (flagString(flags, 'alt-names') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const days = flagInt(flags, 'days', { min: 1, max: 3650 }) ?? 365;

      const pems = await generateCertFn({ commonName, altNames, days });
      // --force replaces a working key pair: keep the old files beside it (audit G06).
      if (existsSync(certPath)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        for (const file of [certPath, path.join(certDir, 'key.pem')]) {
          if (existsSync(file)) copyFileSync(file, `${file}.bak-${stamp}`);
        }
      }
      const paths = writeCertFilesFn(certDir, pems);

      // eslint-disable-next-line no-console
      console.log(`Generated self-signed certificate for "${commonName}" (${days} days) at ${paths.certPath}.`);
      return 0;
    },
  });

  cli.command('cert renew', {
    description: 'Reissue the certificate, keeping the same subjectAltName',
    async handler() {
      if (!existsSync(certPath)) {
        // eslint-disable-next-line no-console
        console.error(`No certificate at ${certPath} to renew - run \`cert generate\` first.`);
        return 1;
      }

      const existing = readCertInfoFn(certPath);
      // subjectAltName comes back as "DNS:foo, DNS:bar, IP Address:1.2.3.4" -
      // extract just the values, same set `cert generate` would have been
      // given originally.
      const names = (existing.subjectAltName ?? '')
        .split(',')
        .map((s) => s.trim().replace(/^DNS:|^IP Address:/, ''))
        .filter(Boolean);
      const [commonName, ...altNames] = names.length > 0 ? names : [defaultCommonName];

      // Same validity period as the certificate being replaced (never the fixed 365 days), clamped to what `generate` accepts.
      const spanDays = existing.validFrom && existing.validTo ? Math.round((new Date(existing.validTo) - new Date(existing.validFrom)) / 86_400_000) : 365;
      const days = Math.min(3650, Math.max(1, Number.isFinite(spanDays) ? spanDays : 365));
      const pems = await generateCertFn({ commonName, altNames, days });
      // The working pair is replaced: keep the old files beside it, as `generate --force` does.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      for (const file of [certPath, path.join(certDir, 'key.pem')]) {
        if (existsSync(file)) copyFileSync(file, `${file}.bak-${stamp}`);
      }
      const paths = writeCertFilesFn(certDir, pems);

      // eslint-disable-next-line no-console
      console.log(`Renewed certificate for "${commonName}" (same SAN, ${days} days) at ${paths.certPath}; the previous pair is kept as *.bak-${stamp}.`);
      return 0;
    },
  });

  cli.command('cert trust', {
    description: 'Print OS-specific instructions for trusting this self-signed certificate locally',
    handler() {
      // eslint-disable-next-line no-console
      console.log(TRUST_INSTRUCTIONS.replace(/<cert\.pem>/g, certPath));
      return 0;
    },
  });
}
