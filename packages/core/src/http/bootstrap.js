import { randomBytes } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import helmet from 'helmet';

/** Accepted shape for an incoming X-Request-Id (audit A17): bounded
 * length, no whitespace/control characters, so a client cannot inject
 * log lines or make the correlation id arbitrarily large. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Request-id middleware: assigns req.id (reuses an incoming
 * X-Request-Id if present AND well-formed, e.g. from a reverse proxy,
 * so traces stay correlated end-to-end - anything else is replaced by
 * a fresh UUID) and echoes it back in the response header. Error pages
 * and logs both key off req.id.
 *
 * Mount it FIRST, before body parsers, so a body-parse error still
 * carries a request id.
 */
export function requestId() {
  return (req, res, next) => {
    const incoming = req.headers?.['x-request-id'];
    req.id = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : uuidv4();
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}

/**
 * Security headers. The CSP allows scripts only from 'self' plus a
 * per-request nonce (audit A01: a plain `script-src 'self'` silently
 * broke every server-rendered page that uses a small inline script).
 * The nonce is exposed as `res.locals.cspNonce` / `req.cspNonce`;
 * templates must put it on their OWN <script nonce="..."> tags and
 * nowhere near user-controlled markup - never rewrite arbitrary HTML
 * to add it, or an injected <script> would be blessed too.
 *
 * Also sets (audit A18): object-src 'none', base-uri 'self',
 * form-action 'self', frame-ancestors 'none', Permissions-Policy,
 * Cross-Origin-Opener/Resource-Policy, and - only on requests that
 * arrived over HTTPS - Strict-Transport-Security (browsers ignore HSTS
 * sent over plain HTTP, and sending it there is misleading).
 *
 * @param {object} [opts]
 * @param {string[]} [opts.extraConnectSrc]
 * @param {false | {reportUri?: string}} [opts.reportOnly] - also send a stricter policy as `Content-Security-Policy-Report-Only`
 *   (styles only from `'self'` and the nonce, no `'unsafe-inline'`) with violations reported to `reportUri` (default `/csp-report`, see `cspReports`).
 *   Nothing is blocked by it: it shows what stands in the way of tightening the real policy.
 * @param {false | {maxAgeSeconds?: number, includeSubDomains?: boolean, preload?: boolean}} [opts.hsts]
 *   default: one year, includeSubDomains off (opt in deliberately - it
 *   affects every subdomain of the host). `preload` adds the token browsers'
 *   preload list requires (a public domain only; it demands at least a year and
 *   includeSubDomains, and is refused otherwise - removal from the list takes months).
 */
export function securityHeaders({ extraConnectSrc = [], hsts = {}, reportOnly = false } = {}) {
  const reportUri = reportOnly ? (reportOnly.reportUri ?? '/csp-report') : null;
  if (reportUri && !/^\/[\w\-./]*$/.test(reportUri)) throw new TypeError('securityHeaders: reportOnly.reportUri must be a path like /csp-report');
  if (hsts && hsts.preload && (!hsts.includeSubDomains || (hsts.maxAgeSeconds ?? 31_536_000) < 31_536_000)) {
    throw new TypeError('securityHeaders: hsts.preload needs includeSubDomains: true and maxAgeSeconds >= 31536000');
  }
  const hstsValue =
    hsts === false
      ? null
      : `max-age=${hsts.maxAgeSeconds ?? 31_536_000}${hsts.includeSubDomains ? '; includeSubDomains' : ''}${hsts.preload ? '; preload' : ''}`;

  // helmet does the header work (CSP serialisation, COOP/CORP, nosniff,
  // X-Frame-Options, the legacy hardening headers, removal of X-Powered-By).
  // Three things are deliberately NOT left to helmet's defaults:
  //  * CSP `useDefaults: false` - the defaults include upgrade-insecure-requests,
  //    which would break the plain-HTTP reverse-proxy and dev setups;
  //  * HSTS is sent by us, and only on requests that arrived over HTTPS
  //    (helmet would send it on every response, including plain HTTP);
  //  * Permissions-Policy - helmet does not set it.
  const helmetMiddleware = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
        styleSrc: ["'self'", "'unsafe-inline'"], // inline styles still common for component styling
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", ...extraConnectSrc],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    strictTransportSecurity: false,
    referrerPolicy: { policy: 'same-origin' },
    xFrameOptions: { action: 'deny' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  return (req, res, next) => {
    const nonce = randomBytes(16).toString('base64');
    req.cspNonce = nonce;
    res.locals = res.locals ?? {};
    res.locals.cspNonce = nonce;

    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (reportUri) {
      const connect = ["'self'", ...extraConnectSrc].join(' ');
      res.setHeader('Content-Security-Policy-Report-Only', `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; connect-src ${connect}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; report-uri ${reportUri}`);
    }
    if (hstsValue && req.secure) res.setHeader('Strict-Transport-Security', hstsValue);
    helmetMiddleware(req, res, next);
  };
}

/**
 * Wires graceful shutdown for SIGTERM/SIGINT: stops accepting new
 * connections, waits up to drainTimeoutMs for in-flight requests to
 * finish, then force-exits. Prevents the admin-port / reverse-proxy
 * case from leaving connections hanging on deploy.
 *
 * Exit code is 0 only when the drain AND `onShutdown` both succeeded
 * (audit C02: a failing onShutdown used to be masked by exit(0)).
 *
 * @param {import('http').Server} server
 * @param {object} [opts]
 * @param {number} [opts.drainTimeoutMs=10000]
 * @param {() => Promise<void>|void} [opts.onDrainStart] - runs first;
 *   the place to end long-lived streams (SSE) that would otherwise
 *   keep server.close() waiting until the timeout
 * @param {() => Promise<void>|void} [opts.onShutdown] - e.g. close db
 * @param {(code: number) => void} [opts.exit] - injectable for tests
 * @param {string[]} [opts.signals] - signals to hook, default SIGTERM/SIGINT
 * @returns {{shutdown: (signal: string) => Promise<void>}}
 */
export function registerGracefulShutdown(
  server,
  { drainTimeoutMs = 10_000, onDrainStart, onShutdown, exit = (code) => process.exit(code), signals = ['SIGTERM', 'SIGINT'] } = {}
) {
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[das-forge] received ${signal}, draining (max ${drainTimeoutMs}ms)...`);

    const forceExit = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.warn('[das-forge] drain timeout exceeded, forcing exit');
      server.closeAllConnections?.();
      exit(1);
    }, drainTimeoutMs);
    forceExit.unref();

    let code = 0;
    try {
      await onDrainStart?.();
    } catch (err) {
      code = 1;
      // eslint-disable-next-line no-console
      console.error('[das-forge] onDrainStart failed:', err);
    }

    await new Promise((resolve) => {
      server.close(() => resolve());
      // Idle keep-alive sockets would otherwise hold close() open until
      // their own timeout; active requests are left to finish.
      server.closeIdleConnections?.();
    });

    try {
      await onShutdown?.();
    } catch (err) {
      code = 1;
      // eslint-disable-next-line no-console
      console.error('[das-forge] onShutdown failed:', err);
    }
    clearTimeout(forceExit);
    exit(code);
  }

  for (const signal of signals) process.on(signal, () => shutdown(signal));
  return { shutdown, isShuttingDown: () => shuttingDown };
}

/**
 * Last-resort handlers (audit C02): an uncaught exception or unhandled
 * rejection is logged with its stack and the process goes through the SAME
 * graceful shutdown as SIGTERM, then exits non-zero - instead of Node's
 * default of dying without closing the database, or (for rejections on
 * older settings) carrying on in an unknown state.
 *
 * @param {{shutdown: (signal: string) => Promise<void>}} lifecycle - return value of registerGracefulShutdown()
 * @param {object} [opts]
 * @param {{error: Function}} [opts.logger]
 * @param {NodeJS.Process} [opts.proc] - injectable for tests
 */
export function registerFatalHandlers(lifecycle, { logger, proc = process } = {}) {
  const onFatal = (kind) => (err) => {
    if (logger?.error) logger.error(err instanceof Error ? err : new Error(String(err)), `fatal: ${kind}`);
    else console.error(`[das-forge] fatal ${kind}:`, err); // eslint-disable-line no-console
    lifecycle.shutdown(kind);
  };
  proc.on('uncaughtException', onFatal('uncaughtException'));
  proc.on('unhandledRejection', onFatal('unhandledRejection'));
}
