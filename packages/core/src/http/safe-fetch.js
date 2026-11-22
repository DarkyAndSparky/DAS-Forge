/**
 * `safeFetch`: an outgoing HTTP(S) request that checks the address the connection really goes to (A3, SSRF).
 *
 * `assertOutboundUrl` looks at the address as written; a DNS name that points to a forbidden address passes it.
 * Here the name is resolved once, EVERY resulting address is checked, and the connection is made to the checked
 * address itself (the name is kept only for the Host header and TLS server name). A second DNS answer, which is what
 * DNS rebinding relies on, is never used.
 *
 * Always refused: link-local and cloud metadata (also 100.100.100.200), 0.0.0.0/8, 192.0.0.0/24, 198.18.0.0/15, multicast, fec0::/10,
 * the unspecified address. An IPv6 address that only wraps an IPv4 one (mapped, compatible, NAT64, 6to4) is judged as the IPv4 inside.
 * Refused when `allowPrivate` is false: loopback, 10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7.
 * `allowHosts` (exact names, addresses or CIDR) lets an installation reach chosen internal receivers when
 * `allowPrivate` is false; it never lifts the "always refused" ranges.
 * Redirects are not followed (a redirect would be a new, unchecked address). The response is read up to `maxBytes`.
 * No third-party package: node:dns, node:net, node:http(s).
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { assertOutboundUrl } from './outbound.js';

const mk = (list) => { const b = new net.BlockList(); for (const [a, p, f] of list) b.addSubnet(a, p, f); return b; };
const ALWAYS = mk([
  ['0.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'], ['::', 128, 'ipv6'], ['fd00:ec2::254', 128, 'ipv6'],
  // audit S-04: benchmarking and protocol ranges, the old site-local range, the local NAT64 prefix, Alibaba's metadata address
  ['198.18.0.0', 15, 'ipv4'], ['192.0.0.0', 24, 'ipv4'], ['100.100.100.200', 32, 'ipv4'], ['fec0::', 10, 'ipv6'], ['64:ff9b:1::', 48, 'ipv6'],
]);
const PRIVATE = mk([
  ['127.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'], ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'],
]);

/** The 16 bytes of an IPv6 address (net.isIPv6 must already be true), or null. */
function bytes6(ip) {
  let s = ip.toLowerCase().split('%')[0];
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (tail) s = s.slice(0, tail.index) + ((Number(tail[1]) << 8) | Number(tail[2])).toString(16) + ':' + ((Number(tail[3]) << 8) | Number(tail[4])).toString(16);
  const [head, rest, extra] = s.split('::');
  if (extra !== undefined) return null;
  const h = head ? head.split(':') : [];
  const r = rest === undefined ? [] : rest ? rest.split(':') : [];
  const fill = rest === undefined ? 0 : 8 - h.length - r.length;
  if (fill < 0 || (rest === undefined && h.length !== 8)) return null;
  const groups = [...h, ...Array(fill).fill('0'), ...r].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => !(g >= 0 && g <= 0xffff))) return null;
  return groups.flatMap((g) => [g >> 8, g & 255]);
}

/**
 * An IPv6 address that only carries an IPv4 address (audit S-04) is judged as that IPv4 address: IPv4-mapped (::ffff:a.b.c.d,
 * also in hex form), IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16).
 */
function unmap(ip) {
  if (!net.isIPv6(ip)) return ip;
  const b = bytes6(ip);
  if (!b) return ip;
  const zeros = (from, to) => b.slice(from, to).every((x) => x === 0);
  const v4 = (o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
  if (zeros(0, 10) && b[10] === 255 && b[11] === 255) return v4(12);
  if (zeros(0, 12) && !zeros(12, 16) && !(zeros(12, 15) && b[15] === 1)) return v4(12); // ::a.b.c.d (but not ::1)
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return v4(12);
  if (b[0] === 0x20 && b[1] === 0x02) return v4(2);
  return ip;
}
const fam = (ip) => (net.isIPv4(ip) ? 'ipv4' : 'ipv6');

/** @returns {string|null} why the address is refused, or null when it may be used */
export function refusedAddress(ip, { allowPrivate = true, allowHostsBlock = null } = {}) {
  const a = unmap(ip);
  if (!net.isIP(a)) return 'not an IP address';
  if (ALWAYS.check(a, fam(a))) return 'link-local, metadata, multicast or unspecified range';
  if (!allowPrivate && PRIVATE.check(a, fam(a)) && !(allowHostsBlock && allowHostsBlock.check(a, fam(a)))) return 'private or loopback range (outbound.allowPrivate is off)';
  return null;
}

function parseAllow(allowHosts) {
  const names = new Set(); const block = new net.BlockList();
  for (const e of allowHosts) {
    const s = String(e).trim().toLowerCase();
    const cidr = /^(.+)\/(\d{1,3})$/.exec(s);
    if (cidr && net.isIP(cidr[1])) block.addSubnet(cidr[1], Number(cidr[2]), fam(cidr[1]));
    else if (net.isIP(s)) block.addAddress(s, fam(s));
    else names.add(s);
  }
  return { names, block };
}

/**
 * @param {object} [o]
 * @param {boolean} [o.allowPrivate=true]
 * @param {string[]} [o.allowHosts]
 * @param {number} [o.maxBytes=1048576]
 * @param {number} [o.timeoutMs=10000]
 * @param {(host:string)=>Promise<string[]>} [o.resolve] - all addresses of a name (injectable for tests)
 * @param {Function} [o.requestImpl] - `http.request`/`https.request` replacement (injectable for tests)
 * @returns {(url: string|URL, init?: {method?:string, headers?:object, body?:string|Buffer, signal?:AbortSignal}) => Promise<Response>}
 */
export function createSafeFetch({ allowPrivate = true, allowHosts = [], maxBytes = 1_048_576, timeoutMs = 10_000, resolve, requestImpl } = {}) {
  const allow = parseAllow(allowHosts);
  const lookupAll = resolve ?? (async (h) => (await dns.promises.lookup(h, { all: true, verbatim: true })).map((r) => r.address));

  return async function safeFetch(url, init = {}) {
    const u = assertOutboundUrl(url, { label: 'outbound', protocols: ['https:', 'http:'] });
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const named = allow.names.has(host.toLowerCase());
    const addrs = net.isIP(host) ? [host] : await lookupAll(host);
    if (!addrs.length) throw new TypeError(`outbound: ${host} did not resolve`);
    for (const ip of addrs) {
      const why = refusedAddress(ip, { allowPrivate: allowPrivate || named, allowHostsBlock: allow.block });
      if (why) throw new TypeError(`outbound: ${host} resolves to ${ip}: ${why}`);
    }
    const ip = unmap(addrs[0]);
    const lib = u.protocol === 'https:' ? https : http;
    const doRequest = requestImpl ?? lib.request;
    const body = init.body == null ? null : Buffer.from(init.body);
    const headers = { ...(init.headers ?? {}), host: u.host };
    if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) headers['content-length'] = body.length;

    return await new Promise((resolvePromise, reject) => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      const req = doRequest({
        protocol: u.protocol, host: ip, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET', headers, servername: net.isIP(host) ? undefined : host, signal,
      }, (res) => {
        const chunks = []; let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) { res.destroy(new RangeError(`outbound: the response is larger than ${maxBytes} bytes`)); return; }
          chunks.push(c);
        });
        res.on('error', reject);
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) { reject(new TypeError(`outbound: redirect to ${res.headers.location} is not followed`)); return; }
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) for (const x of [].concat(v)) h.append(k, x);
          const noBody = [101, 204, 205, 304].includes(status);
          resolvePromise(new Response(noBody ? null : Buffer.concat(chunks), { status, headers: h }));
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  };
}

let policy = { allowPrivate: true, allowHosts: [] };
let shared = createSafeFetch();

/** Sets the policy of the shared `safeFetch` (call once at start-up; see `outboundPolicyFromConfig`). */
export function setOutboundPolicy(p = {}) {
  policy = { allowPrivate: p.allowPrivate ?? true, allowHosts: p.allowHosts ?? [] };
  shared = createSafeFetch(policy);
}
export const getOutboundPolicy = () => ({ ...policy, allowHosts: [...policy.allowHosts] });

/** The shared, policy-bound fetch. The default of every core consumer. */
export const safeFetch = (url, init) => shared(url, init);

/** Policy from `server`: `outbound.allowPrivate` unset means "no" for exposure 'internet' and "yes" for 'lan'. */
export function outboundPolicyFromConfig(server = {}) {
  return { allowPrivate: server.outbound?.allowPrivate ?? server.exposure !== 'internet', allowHosts: server.outbound?.allowHosts ?? [] };
}
