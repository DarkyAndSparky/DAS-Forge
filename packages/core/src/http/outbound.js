/**
 * Checks of an address the core is about to call (webhook, log collector, package registry): the server must not
 * be turned into a way to reach what only it can reach (SSRF, G-08).
 *
 * What is refused, always: a scheme other than the allowed ones, and the "link-local" range that holds cloud
 * metadata services (169.254.0.0/16 including 169.254.169.254, IPv6 fe80::/10, the AWS IPv6 metadata address and the
 * well-known metadata host names), also when written as a decimal/hex number or inside an IPv4-mapped IPv6 address
 * (the URL parser turns those into the dotted form first).
 *
 * What is NOT refused on purpose: loopback and private networks (10.x, 172.16.x, 192.168.x). On-premises installations
 * send logs and alerts to collectors and chat gateways inside their own network; refusing those would break the intended use.
 *
 * Limits, so nobody trusts this more than it gives: the check looks at the address as written. A DNS name that
 * points to a refused address is not caught (that needs the resolved address at connection time).
 */
import net from 'node:net';

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data', 'instance-data.ec2.internal']);

/** True for an IP literal in a range that is refused. @param {string} host hostname as `URL.hostname` gives it */
export function isBlockedHost(host) {
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (METADATA_HOSTS.has(h)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h); // the parser writes the mapped form in hex
  let v4 = mapped ? mapped[1] : null;
  if (hex) { const a = parseInt(hex[1], 16); const b = parseInt(hex[2], 16); v4 = `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`; }
  if (v4 ?? net.isIPv4(h)) {
    const [a, b] = (v4 ?? h).split('.').map(Number);
    return a === 169 && b === 254;
  }
  if (net.isIPv6(h)) {
    const first = parseInt(h.split(':')[0] || '0', 16);
    return (first & 0xffc0) === 0xfe80 || h === 'fd00:ec2::254';
  }
  return false;
}

/**
 * @param {string|URL} url
 * @param {{label?: string, protocols?: string[]}} [o] - `protocols` such as ['https:'] or ['https:', 'http:']
 * @returns {URL} the parsed address
 * @throws {TypeError} not an address, wrong scheme, or a refused range
 */
export function assertOutboundUrl(url, { label = 'url', protocols = ['https:'] } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new TypeError(`${label}: not a valid URL`); }
  if (!protocols.includes(u.protocol)) throw new TypeError(`${label}: only ${protocols.map((p) => p.replace(':', '')).join(' or ')} addresses are allowed`);
  if (isBlockedHost(u.hostname)) throw new TypeError(`${label}: the address points to a link-local or metadata range and is refused`);
  return u;
}
