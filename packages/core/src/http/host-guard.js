import { sendError } from './respond.js';

/**
 * Host-name check (audit S-08). A request whose `Host` is not one of the names this installation is known by gets
 * `421 Misdirected Request`. It stops a forged Host from reaching the login page, a cache that keys on Host from
 * being poisoned, and a proxy that forwards "anything" from reaching the application.
 *
 * Always allowed: `localhost`, `127.0.0.1`, `::1`. Added: `server.allowedHosts` and the host of `email.baseUrl`.
 *
 * `server.hostCheck`:
 *   'auto' (default) - enforce when at least one name is configured, otherwise only watch and warn ("warn");
 *   'enforce'        - always answer 421 for an unknown name (with no names configured only localhost works);
 *   'warn'           - let the request through, write one security-log line per name per minute;
 *   'off'            - no check.
 */

const LOCAL = ['localhost', '127.0.0.1', '::1'];

/** Lower-case host name without port and without brackets of an IPv6 literal. */
export function normalizeHost(value) {
  let h = String(value ?? '').trim().toLowerCase();
  if (h.startsWith('[')) { const i = h.indexOf(']'); return i < 0 ? '' : h.slice(1, i); }
  if ((h.match(/:/g) ?? []).length === 1) h = h.slice(0, h.indexOf(':'));
  return h.replace(/\.$/, '');
}

/**
 * What the check will do with this configuration (also read by the health panel).
 * @returns {{ mode: 'off'|'warn'|'enforce', configured: boolean, names: string[] }}
 */
export function hostPolicyFromConfig(appConfig = {}) {
  const server = appConfig.server ?? {};
  const names = new Set();
  for (const h of server.allowedHosts ?? []) names.add(normalizeHost(h));
  const base = appConfig.email?.baseUrl;
  if (base) { try { names.add(normalizeHost(new URL(base).hostname)); } catch { /* an unreadable address is reported by the config check */ } }
  names.delete('');
  const configured = names.size > 0;
  const setting = server.hostCheck ?? 'auto';
  const mode = setting === 'auto' ? (configured ? 'enforce' : 'warn') : setting;
  return { mode, configured, names: [...names] };
}

/**
 * @param {object} opts
 * @param {string[]} [opts.allowedHosts] - extra names (no port)
 * @param {'off'|'warn'|'enforce'} [opts.mode='enforce']
 * @param {(info: {host: string, ip: string, path: string, mode: string}) => void} [opts.onViolation] - at most once per name per minute
 * @param {boolean} [opts.trustProxy=false] - read X-Forwarded-Host (only when the proxy is trusted)
 * @param {string[]} [opts.exemptPaths] - exact paths always answered (a health probe that calls by IP)
 */
export function hostGuard({ allowedHosts = [], mode = 'enforce', onViolation, trustProxy = false, exemptPaths = [], now = () => Date.now() } = {}) {
  if (mode === 'off') return (req, res, next) => next();
  const allowed = new Set([...LOCAL, ...allowedHosts.map(normalizeHost)]);
  const seen = new Map();
  return function hostGuardMiddleware(req, res, next) {
    if (exemptPaths.includes(req.path)) return next();
    const raw = (trustProxy ? String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim() : '') || req.headers.host;
    const host = normalizeHost(raw);
    if (host && allowed.has(host)) return next();
    if (onViolation) {
      const t = now();
      if (t - (seen.get(host) ?? -Infinity) >= 60_000) {
        if (seen.size > 500) seen.clear();
        seen.set(host, t);
        try { onViolation({ host: host.slice(0, 200), ip: req.ip, path: req.path, mode }); } catch { /* a failing log must not break the answer */ }
      }
    }
    if (mode === 'warn') return next();
    return sendError(req, res, 421, { error: 'HOST_REJECTED', fields: [] });
  };
}
