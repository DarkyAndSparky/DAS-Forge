import { writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';

/** §4.5f: "Сертификат кладётся в data/certs/{cert.pem,key.pem}". */
export function certFilePaths(certDir) {
  return { certPath: path.join(certDir, 'cert.pem'), keyPath: path.join(certDir, 'key.pem') };
}

/**
 * Writes a generated {cert, key} pair to certDir/cert.pem and
 * certDir/key.pem, creating the directory if needed. The private key
 * file is written with owner-only permissions (0600) - the cert file is
 * public by nature (sent to every client that connects) and gets normal
 * permissions, but a readable-by-anyone private key defeats the point
 * of HTTPS entirely, so this is not optional.
 */
export function writeCertFiles(certDir, { cert, key }) {
  if (!existsSync(certDir)) {
    mkdirSync(certDir, { recursive: true });
  }

  const { certPath, keyPath } = certFilePaths(certDir);
  writeFileSync(certPath, cert);
  writeFileSync(keyPath, key, { mode: 0o600 });
  // writeFileSync's mode is only applied when CREATING a new file - if
  // keyPath already existed (a `cert generate --force` overwrite), its
  // old permissions would otherwise survive untouched.
  chmodSync(keyPath, 0o600);

  return { certPath, keyPath };
}
