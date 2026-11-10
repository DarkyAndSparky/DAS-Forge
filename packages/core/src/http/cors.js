import cors from 'cors';

/**
 * CORS on top of the `cors` package, driven by an explicit allow-list
 * (`security.cors.origins`).
 *
 * Secure by construction:
 *   - an empty list means "no cross-origin access": the returned middleware
 *     adds nothing and does nothing (the browser's same-origin policy stays);
 *   - origins are matched exactly (scheme + host + port); there are no
 *     wildcards, and `*` in the list is a configuration error because this
 *     layer is used with credentials (cookies) - `*` with credentials is
 *     either rejected by browsers or, worse, "fixed" by reflecting any origin;
 *   - the literal origin `null` (sandboxed iframes, file://, redirects) is
 *     never allowed, even if someone writes it in the list;
 *   - a request from an origin that is not listed gets no CORS headers at all,
 *     so the browser blocks the response (the server does not pretend to
 *     reject it - CORS is a browser-side check; CSRF protection is separate).
 *
 * @param {object} [opts]
 * @param {string[]} [opts.origins=[]] - exact allowed origins, e.g. 'https://app.example.com'
 * @param {boolean} [opts.credentials=true] - Access-Control-Allow-Credentials
 * @param {string[]} [opts.methods] - allowed methods for preflight
 * @param {string[]} [opts.allowedHeaders] - allowed request headers for preflight
 * @param {string[]} [opts.exposedHeaders] - response headers the page may read
 * @param {number} [opts.maxAgeSec=600] - preflight cache time
 * @returns {import('express').RequestHandler}
 */
export function createCors({
  origins = [],
  credentials = true,
  methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders = ['Content-Type', 'X-CSRF-Token', 'X-Requested-With'],
  exposedHeaders = ['Retry-After', 'RateLimit', 'RateLimit-Policy'],
  maxAgeSec = 600,
} = {}) {
  const allowed = new Set();
  for (const raw of origins) {
    const origin = String(raw).trim().replace(/\/+$/, '');
    if (origin === '*' || origin.includes('*')) {
      throw new Error(`CORS: wildcard origins are not supported (got "${raw}"); list exact origins`);
    }
    if (origin === '' || origin.toLowerCase() === 'null') continue;
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`CORS: "${raw}" is not a valid origin (expected e.g. https://app.example.com)`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`CORS: "${raw}" must use http or https`);
    }
    allowed.add(parsed.origin);
  }

  if (allowed.size === 0) return (_req, _res, next) => next();

  return cors({
    origin(origin, callback) {
      callback(null, typeof origin === 'string' && allowed.has(origin));
    },
    credentials,
    methods,
    allowedHeaders,
    exposedHeaders,
    maxAge: maxAgeSec,
    optionsSuccessStatus: 204,
  });
}
