import { sendError } from './respond.js';

/**
 * CSRF protection for cookie-authenticated apps - audit finding A03
 * (`security.csrf` defaulted to true in config but nothing enforced it).
 *
 * Token-less, header-based design (OWASP "Verifying Origin With
 * Standard Headers" + Fetch Metadata), chosen because this platform's
 * UI is vanilla server-rendered pages calling JSON endpoints - there is
 * no client framework to carry a per-form token reliably:
 *
 *   1. Safe methods (GET/HEAD/OPTIONS) pass - they must not change state.
 *   2. `Sec-Fetch-Site: cross-site` is rejected outright.
 *   3. If an `Origin` header is present it must match the request's own
 *      host (or an explicitly trusted origin); `Origin: null` is rejected.
 *   4. Otherwise `Sec-Fetch-Site: same-origin | none` passes, and a
 *      `Referer` is checked like an Origin.
 *   5. A request with NONE of those headers is not a modern browser
 *      navigation/fetch (curl, a server-to-server client). CSRF needs
 *      the browser to attach ambient credentials, so such a request is
 *      allowed only if it does NOT carry the session cookie.
 *
 * Needs cookie-parser (or anything populating req.cookies) mounted
 * first, because step 5 inspects the session cookie.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.trustedOrigins] - extra allowed origins, e.g. ['https://admin.example.com']
 * @param {string} [opts.sessionCookieName='das_session']
 * @param {boolean} [opts.trustProxy=false] - honour X-Forwarded-Host when comparing hosts
 * @param {string[]} [opts.strictPaths] - exact paths (e.g. ['/login']) where a request with NO browser signal
 *   (no Origin, Sec-Fetch-Site or Referer) is refused even without a session cookie: closes login-CSRF from clients
 *   that strip those headers, at the price of curl/API logins needing an Origin header (audit K06)
 * @param {string[]} [opts.exemptPaths] - exact paths skipped entirely (webhooks with their own signature)
 */
export function csrfProtection({
  trustedOrigins = [],
  sessionCookieName = 'das_session',
  trustProxy = false,
  exemptPaths = [],
  strictPaths = [],
} = {}) {
  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  const trusted = new Set(trustedOrigins.map((o) => o.replace(/\/$/, '').toLowerCase()));
  const exempt = new Set(exemptPaths);
  const strict = new Set(strictPaths);

  function reject(req, res, reason) {
    return sendError(req, res, 403, { error: 'CSRF_REJECTED', fields: [], reason });
  }

  function hostOf(req) {
    const forwarded = trustProxy ? req.headers?.['x-forwarded-host'] : null;
    // X-Forwarded-Host may be a comma list when several proxies chain.
    return (forwarded ? String(forwarded).split(',')[0].trim() : req.headers?.host ?? '').toLowerCase();
  }

  function originAllowed(originValue, req) {
    let u;
    try {
      u = new URL(originValue);
    } catch {
      return false;
    }
    if (trusted.has(u.origin.toLowerCase())) return true;
    const host = hostOf(req);
    return host !== '' && u.host.toLowerCase() === host;
  }

  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (exempt.has(req.path ?? req.url)) return next();

    const headers = req.headers ?? {};
    const fetchSite = headers['sec-fetch-site'];
    const origin = headers.origin;

    if (fetchSite === 'cross-site') return reject(req, res, 'cross-site request');

    if (origin !== undefined) {
      if (origin === 'null') return reject(req, res, 'opaque origin');
      return originAllowed(origin, req) ? next() : reject(req, res, 'origin mismatch');
    }

    if (fetchSite === 'same-origin' || fetchSite === 'none') return next();
    if (fetchSite === 'same-site') return reject(req, res, 'same-site but not same-origin');

    if (headers.referer) {
      return originAllowed(headers.referer, req) ? next() : reject(req, res, 'referer mismatch');
    }

    if (strict.has(req.path ?? req.url)) return reject(req, res, 'no origin signal on a strict path');
    // No browser-origin signal at all: allow only credential-less clients.
    if (req.cookies?.[sessionCookieName]) return reject(req, res, 'cookie-authenticated request without origin');
    next();
  };
}
