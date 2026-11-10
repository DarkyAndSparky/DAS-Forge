import http from 'node:http';
import https from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Server construction that actually honours `server.*` config - audit
 * findings A04/C05: host, https.mode, trustProxy, requestTimeoutMs were
 * declared in config/schema.js but every app just called
 * `app.listen(port)` (plain HTTP on ALL interfaces, ignoring `host`).
 *
 * `https.mode` semantics (§4.5f):
 *   - 'standalone'    this process terminates TLS with the cert/key at
 *                     server.https.certPath / keyPath
 *   - 'self-signed'   this process terminates TLS with a self-signed
 *                     cert kept in the app's cert directory (generated
 *                     on first start if missing, see loadOrCreateTls)
 *   - 'reverse-proxy' this process speaks plain HTTP on a private
 *                     interface behind a TLS-terminating proxy; that
 *                     proxy MUST be trusted (server.trustProxy: true)
 *                     or req.secure/req.ip would be wrong, so the
 *                     combination reverse-proxy + trustProxy:false is
 *                     refused at startup rather than silently running
 *                     with cookies that are not marked Secure.
 */

/** Applies app-level settings derived from server config to an Express
 * app. Throws on an unsafe combination (see above). */
export function applyServerSettings(app, serverConfig) {
  const mode = serverConfig.https?.mode ?? 'self-signed';
  if (mode === 'reverse-proxy' && !serverConfig.trustProxy) {
    throw new Error(
      "server.https.mode is 'reverse-proxy' but server.trustProxy is false - " +
        'req.secure and req.ip would be wrong behind the proxy. Set server.trustProxy: true.'
    );
  }
  // Never Express's `true` (it trusts every X-Forwarded-For hop, so a client could spoof its IP and slip past the
  // rate limiter): our `true` means ONE hop; a number is that many hops (CDN + nginx = 2); a list is the trusted
  // proxy addresses/subnets (audit L04).
  const tp = serverConfig.trustProxy;
  app.set('trust proxy', tp === true ? 1 : Array.isArray(tp) ? tp : Number.isInteger(tp) && tp > 0 ? tp : false);
  app.disable('x-powered-by');
}

/**
 * Returns a `(req) => boolean` deciding the cookie `Secure` flag.
 * Terminating TLS ourselves => always true. Behind a proxy => whatever
 * the (trusted) X-Forwarded-Proto says, which Express exposes as
 * req.secure once `trust proxy` is set by applyServerSettings().
 */
export function secureCookiePolicy(serverConfig) {
  const mode = serverConfig.https?.mode ?? 'self-signed';
  return mode === 'reverse-proxy' ? (req) => Boolean(req.secure) : () => true;
}

/**
 * Loads (and for 'self-signed' creates on first start) the TLS
 * credentials for the configured mode. Takes the core/certs namespace
 * as a parameter instead of importing it, so this file stays free of
 * the native/heavy dependencies certs pulls in.
 *
 * @param {object} opts
 * @param {object} opts.serverConfig
 * @param {string} opts.certDir - where cert.pem/key.pem live in self-signed mode
 * @param {{generateSelfSignedCert: Function, writeCertFiles: Function, certFilePaths: Function}} [opts.certs]
 * @param {string} [opts.commonName='localhost']
 * @returns {Promise<{cert: Buffer|string, key: Buffer|string} | null>} null in reverse-proxy mode
 */
export async function loadOrCreateTls({ serverConfig, certDir, certs, commonName = 'localhost' }) {
  const mode = serverConfig.https?.mode ?? 'self-signed';
  if (mode === 'reverse-proxy') return null;

  if (mode === 'standalone') {
    const { certPath, keyPath } = serverConfig.https;
    if (!certPath || !keyPath) {
      throw new Error("server.https.mode is 'standalone' but certPath/keyPath are not both set");
    }
    return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  }

  // self-signed
  if (!certs) throw new TypeError("loadOrCreateTls: 'certs' (core/certs namespace) is required for self-signed mode");
  const { certPath, keyPath } = certs.certFilePaths(certDir);
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    const pems = await certs.generateSelfSignedCert({ commonName, altNames: ['127.0.0.1', '::1'] });
    certs.writeCertFiles(certDir, pems);
  }
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
}

/**
 * Creates (does not start) the Node server for the configured mode,
 * with request/header timeouts applied (audit C05).
 *
 * @param {Function} app - Express app / request listener
 * @param {object} opts
 * @param {object} opts.serverConfig
 * @param {{cert: any, key: any} | null} [opts.tls] - from loadOrCreateTls()
 */
export function createHttpServer(app, { serverConfig, tls = null }) {
  const mode = serverConfig.https?.mode ?? 'self-signed';
  const requestTimeout = serverConfig.requestTimeoutMs ?? 30_000;
  // Node rejects headersTimeout > requestTimeout at construction time.
  const headersTimeout = Math.min(60_000, requestTimeout);
  const timeouts = { requestTimeout, headersTimeout, keepAliveTimeout: 5_000 };

  if (mode === 'reverse-proxy') {
    return http.createServer(timeouts, app);
  }
  if (!tls?.cert || !tls?.key) {
    throw new Error(`createHttpServer: https.mode '${mode}' needs TLS credentials (use loadOrCreateTls)`);
  }
  return https.createServer({ ...timeouts, cert: tls.cert, key: tls.key }, app);
}

/** Promise wrapper around server.listen() that honours `host` and
 * rejects on EADDRINUSE etc. instead of throwing from an event. */
export function listenServer(server, { host, port }) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(server.address());
    });
  });
}

/** Default cert directory helper: `<dataDir>/certs`, per §4.5f. */
export function defaultCertDir(dataDir) {
  return path.join(dataDir, 'certs');
}

/**
 * Port of the plain-HTTP listener that only redirects to HTTPS. Platform convention: an app owns two ports in a row,
 * HTTPS on 9N02 and HTTP on 9N01 (workshop 9002/9001, the next app 9102/9101, ...). Explicit
 * `server.httpRedirectPort` wins (`false` = no redirect listener); otherwise it is `port - 1` whenever this process
 * itself terminates TLS. Behind a reverse proxy the proxy redirects, so there is none.
 *
 * @returns {number|false}
 */
export function resolveRedirectPort(serverConfig) {
  const explicit = serverConfig.httpRedirectPort;
  if (explicit === false) return false;
  if (typeof explicit === 'number') return explicit;
  if ((serverConfig.https?.mode ?? 'self-signed') === 'reverse-proxy') return false;
  return serverConfig.port > 1 ? serverConfig.port - 1 : false;
}

/**
 * A plain-HTTP server that answers EVERY request with `308 Permanent Redirect` to the same path on https (the method
 * and body rules are kept, so a POST is not silently turned into a GET). It serves nothing else.
 *
 * The target host comes from the request's Host header only if it is one of `allowedHosts` (a forged Host header
 * would otherwise turn this into an open redirect); anything else goes to `canonicalHost`.
 *
 * @param {object} opts
 * @param {number} opts.httpsPort
 * @param {string} [opts.canonicalHost='localhost']
 * @param {string[]} [opts.allowedHosts] - host names (no port); `canonicalHost`, localhost and loopback are always allowed
 * @param {(info: {ip: string, method: string, path: string, host: string, count: number}) => void} [opts.onRedirect] -
 *   called for a plain-HTTP hit, at most once per address per `notifyEveryMs`; `count` is how many hits that address made
 *   since the previous call. Nobody should be typing http:// by hand all the time: repeats are worth a security log line.
 *   Never receives the query string. An exception inside it is swallowed.
 * @param {number} [opts.notifyEveryMs=60000]
 * @param {boolean} [opts.redirectUnsafeMethods=false] - by default only GET and HEAD are redirected; POST, PUT, DELETE ... get
 *   `426 Upgrade Required` and a plain-text hint, never a redirect: a client that already sent a body (a password) over
 *   plain HTTP must not be told to quietly repeat it. The hit is reported to `onRedirect` with `refused: true`.
 */
export function createHttpRedirectServer({ httpsPort, canonicalHost = 'localhost', allowedHosts = [], onRedirect, notifyEveryMs = 60_000, redirectUnsafeMethods = false }) {
  const seen = new Map(); // ip -> { at, count }
  const allowed = new Set([canonicalHost, 'localhost', '127.0.0.1', '[::1]', ...allowedHosts].map((h) => String(h).toLowerCase()));
  const hostOnly = (hostHeader) => {
    const h = String(hostHeader ?? '').trim().toLowerCase();
    return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
  };
  const wrap = (h) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);
  return http.createServer({ requestTimeout: 10_000, headersTimeout: 10_000, keepAliveTimeout: 1_000 }, (req, res) => {
    const asked = hostOnly(req.headers.host);
    const host = asked && allowed.has(asked) ? asked : wrap(String(canonicalHost).toLowerCase());
    const target = String(req.url ?? '/').startsWith('/') ? req.url : '/';
    const portPart = Number(httpsPort) === 443 ? '' : `:${httpsPort}`;
    const method = req.method ?? 'GET';
    const refuse = !redirectUnsafeMethods && method !== 'GET' && method !== 'HEAD';
    if (onRedirect) {
      const ip = req.socket?.remoteAddress ?? 'unknown';
      const now = Date.now();
      const rec = seen.get(ip) ?? { at: 0, count: 0 };
      rec.count += 1;
      if (now - rec.at >= notifyEveryMs) {
        const info = { ip, method, path: String(target).split('?')[0], host, count: rec.count, refused: refuse };
        rec.at = now;
        rec.count = 0;
        try { onRedirect(info); } catch { /* a callback must not break the redirect */ }
      }
      if (seen.size >= 1000 && !seen.has(ip)) seen.delete(seen.keys().next().value);
      seen.set(ip, rec);
    }
    if (refuse) {
      const body = `HTTPS is required. Use https://${host}${portPart}/ - the request was NOT processed and not redirected.\n`;
      res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), Connection: 'close', 'Cache-Control': 'no-store', Upgrade: 'TLS/1.2, HTTP/1.1' });
      res.end(body);
      return;
    }
    res.writeHead(308, { Location: `https://${host}${portPart}${target}`, 'Content-Length': '0', Connection: 'close', 'Cache-Control': 'no-store' });
    res.end();
  });
}
