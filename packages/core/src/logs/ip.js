import net from 'node:net';

/**
 * Shortens an IP address for logs that must not identify one person (GDPR-style data minimisation):
 * IPv4 keeps the first three octets (`203.0.113.0`), IPv6 the first /48 (`2001:db8:1::`). `none` drops it.
 *
 * @param {string|undefined} ip
 * @param {'full'|'truncate'|'none'} [mode='full']
 * @returns {string|undefined}
 */
export function anonymizeIp(ip, mode = 'full') {
  if (mode === 'full' || ip === undefined || ip === null || ip === '') return ip ?? undefined;
  if (mode === 'none') return undefined;
  let s = String(ip);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) s = mapped[1];
  if (net.isIPv4(s)) return `${s.split('.').slice(0, 3).join('.')}.0`;
  if (net.isIPv6(s)) {
    const [head, tail = ''] = s.split('::');
    const groups = head.split(':').filter(Boolean);
    if (!s.includes('::') || groups.length >= 3) {
      return `${s.split(':').slice(0, 3).join(':')}::`;
    }
    const full = [...groups, ...Array(Math.max(0, 8 - groups.length - tail.split(':').filter(Boolean).length)).fill('0'), ...tail.split(':').filter(Boolean)];
    return `${full.slice(0, 3).join(':')}::`;
  }
  return 'invalid';
}
