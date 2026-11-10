import { timingSafeEqual, createHash } from 'node:crypto';

/**
 * Prometheus metrics (`/metrics`). A thin layer over `@prometheus-io/client` (loaded only when metrics are switched on):
 * request counters and latency, process metrics (memory, event-loop lag), and gauges the application or the core
 * register (mail queue, sessions, age of the last backup). The endpoint is closed by default: it answers 404 unless the request comes
 * from an allowed address or carries the bearer token, so the application's internals are never shown to anyone else.
 */
const SAFE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

const sha = (s) => createHash('sha256').update(String(s)).digest();
const sameToken = (a, b) => timingSafeEqual(sha(a), sha(b));

/**
 * @param {object} [o]
 * @param {string} [o.prefix='das_']
 * @param {boolean} [o.defaultMetrics=true] - process metrics (memory, CPU, event-loop lag, GC)
 * @param {() => Promise<object>} [o.importClient] - how the client package is loaded (replaced in tests)
 */
export async function createPrometheusMetrics({ prefix = 'das_', defaultMetrics = true, importClient = () => import('@prometheus-io/client') } = {}) {
  if (!SAFE_NAME.test(prefix)) throw new TypeError('metrics prefix must be a valid metric name part');
  let client;
  try {
    client = await importClient();
  } catch (err) {
    const e = new Error('Prometheus metrics need the package "@prometheus-io/client" (npm install @prometheus-io/client)');
    e.code = 'METRICS_PACKAGE_MISSING';
    e.cause = err;
    throw e;
  }
  const { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } = client.default ?? client;
  const registry = new Registry();
  if (defaultMetrics && typeof collectDefaultMetrics === 'function') collectDefaultMetrics({ register: registry, prefix });

  const requests = new Counter({ name: `${prefix}http_requests_total`, help: 'HTTP requests by method, route template and status class', labelNames: ['method', 'route', 'status'], registers: [registry] });
  const duration = new Histogram({ name: `${prefix}http_request_duration_seconds`, help: 'HTTP request duration in seconds', labelNames: ['method', 'route'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [registry] });

  /** Express middleware: counts every finished request. The route is the template ("/users/:id"), never the raw URL, so labels stay few. */
  function middleware() {
    return (req, res, next) => {
      const start = process.hrtime.bigint();
      res.on('finish', () => {
        const route = req.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : 'unmatched';
        const method = String(req.method ?? 'GET').toUpperCase();
        requests.inc({ method, route, status: `${Math.trunc((res.statusCode ?? 0) / 100)}xx` });
        duration.observe({ method, route }, Number(process.hrtime.bigint() - start) / 1e9);
      });
      next();
    };
  }

  /**
   * A gauge whose value is read when the endpoint is scraped. `collect` returns a number, or null when unknown (then the sample is skipped).
   * @param {{name: string, help: string, collect: () => number|null|Promise<number|null>}} g
   */
  function addGauge({ name, help, collect }) {
    if (!SAFE_NAME.test(name)) throw new TypeError(`bad metric name: ${name}`);
    new Gauge({
      name: `${prefix}${name}`, help, registers: [registry],
      async collect() {
        try {
          const v = await collect();
          if (typeof v === 'number' && Number.isFinite(v)) this.set(v);
        } catch { /* a failing source must not break the whole scrape */ }
      },
    });
  }

  const render = () => registry.metrics();

  /**
   * Handler for `GET /metrics`. Mount it BEFORE sessions, CSRF and body parsing.
   * @param {object} [o]
   * @param {string} [o.token] - bearer token; with none set only `allowIps` can read
   * @param {string[]} [o.allowIps] - addresses allowed without a token (default: this machine)
   */
  function handler({ token, allowIps = LOOPBACK } = {}) {
    const allowed = new Set(allowIps);
    return async (req, res) => {
      const auth = String(req.headers?.authorization ?? '');
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const okToken = Boolean(token) && bearer !== '' && sameToken(bearer, token);
      const okIp = allowed.has(req.socket?.remoteAddress ?? req.ip);
      if (!okToken && !okIp) return res.status(404).end();
      try {
        res.set('Content-Type', registry.contentType);
        res.set('Cache-Control', 'no-store');
        return res.status(200).send(await render());
      } catch {
        return res.status(500).end();
      }
    };
  }

  return { registry, middleware, addGauge, handler, render };
}
