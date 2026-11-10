
/**
 * §4.5f: "Библиотека: selfsigned (чистый JS, без нативных биндингов и
 * без необходимости в OpenSSL CLI - не обязательное требование -
 * selfsigned работает всегда и везде)". NOT implemented via shelling
 * out to an `openssl` CLI (even though one happens to be present in
 * this dev container) - that would make cert generation depend on
 * whatever happens to be installed on the host, exactly what the doc's
 * library choice is explicitly avoiding.
 *
 * `selfsigned` is at major version 5 (5.5.0 as of writing - verified on
 * npm, not assumed from training data, per this project's standing
 * dependency-freshness rule) - v5 rewrote the library around Node's
 * native WebCrypto and made `generate()` async-only (no more callback
 * or sync forms). This function is async for that reason.
 *
 * @param {object} opts
 * @param {string} opts.commonName - e.g. 'localhost' or the app's hostname
 * @param {string[]} [opts.altNames] - additional DNS names/IPs for
 *   subjectAltName; every modern browser/HTTP client requires SAN, a
 *   bare CN-only cert is rejected by Chrome/Firefox/curl alike
 * @param {number} [opts.days=365]
 * @param {number} [opts.keySize=2048]
 * @returns {Promise<{cert: string, key: string}>} PEM-encoded certificate and private key
 */
export async function generateSelfSignedCert({ commonName, altNames = [], days = 365, keySize = 2048 }) {
  if (!commonName) {
    throw new TypeError('generateSelfSignedCert requires a commonName');
  }
  // Loaded on first use so importing core doesn't pull selfsigned (audit D03).
  const selfsignedModule = await import('selfsigned');
  const selfsigned = selfsignedModule.default ?? selfsignedModule;

  const attrs = [{ name: 'commonName', value: commonName }];

  // subjectAltName entries: type 2 = DNS name, type 7 = IP address.
  // A bare IPv4/IPv6-looking string is encoded as an IP entry, anything
  // else (hostnames, 'localhost') as a DNS entry - the same convention
  // `selfsigned`'s own docs use.
  const IPV4_OR_V6 = /^(\d{1,3}\.){3}\d{1,3}$|:/;
  const altNameEntries = [commonName, ...altNames].map((value) =>
    IPV4_OR_V6.test(value) ? { type: 7, ip: value } : { type: 2, value }
  );

  // selfsigned v5 has no `days` option (confirmed against its actual
  // source, not assumed from training data/older versions - it was
  // silently ignored here before this fix, so every cert generated came
  // out with the library's own 365-day default regardless of `days`).
  // v5 instead takes an explicit `notAfterDate`; compute it from `days`.
  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate);
  notAfterDate.setDate(notAfterDate.getDate() + days);

  const pems = await selfsigned.generate(attrs, {
    notBeforeDate,
    notAfterDate,
    keySize,
    extensions: [{ name: 'subjectAltName', altNames: altNameEntries }],
  });

  return { cert: pems.cert, key: pems.private };
}
