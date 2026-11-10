import { createRequire } from 'node:module';
import { anonymizeIp } from './ip.js';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import pinoHttp from 'pino-http';

/**
 * core/logs (audit C03) on top of `pino` + `pino-http`: one JSON object
 * per line (stdout, or stderr for warn/error when no stream is given),
 * levels, child loggers that carry bindings such as the request id.
 * Serialisation, level handling and the output stream are pino's; the
 * module's own API (`createLogger`, `log.info('msg', {fields})`,
 * `log.child`, `accessLog`) stays the same.
 *
 * What pino does not give out of the box, and this file adds:
 *   - Redaction by KEY NAME (case-insensitive, any depth, bounded): a
 *     value under `authorization`, `cookie`, `password`, `token`,
 *     `secret`, `sessionSecret`, `apiKey`, ... becomes "[REDACTED]" before
 *     the line is written (pino's own `redact` needs exact paths).
 *   - Error objects (under any key) as {name, message, stack, code}.
 *   - Both call shapes: log.info('msg', {fields}) and log.info({fields}, 'msg').
 *   - A logger never throws into the code that is logging.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const DEFAULT_REDACT = /pass(word|phrase|wd)?|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|totp|recovery|credential|session/i;

function serialize(value, redact, depth = 0, seen = new WeakSet()) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack, ...(value.code ? { code: value.code } : {}) };
  }
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => serialize(v, redact, depth + 1, seen));
  if (value instanceof Date) return value.toISOString();
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = redact.test(k) ? '[REDACTED]' : serialize(v, redact, depth + 1, seen);
  }
  return out;
}

/** Calls with (msg, fields) | (fields, msg) | (err, msg) -> pino's (fields, msg). */
function adapt(a, b) {
  let fields = {};
  let msg = '';
  if (typeof a === 'string') {
    msg = a;
    if (b && typeof b === 'object') fields = b instanceof Error ? { err: b } : { ...b };
  } else if (a instanceof Error) {
    fields = { err: a };
    msg = typeof b === 'string' ? b : a.message;
  } else if (a && typeof a === 'object') {
    fields = { ...a };
    msg = typeof b === 'string' ? b : '';
  }
  return [fields, msg];
}

/** The module's logger API around a pino instance (also used for the per-request logger). */
function wrapLogger(instance, redact, level) {
  const call = (lvl) => (a, b) => {
    try {
      const [fields, msg] = adapt(a, b);
      instance[lvl](fields, msg);
    } catch {
      /* a logger must never throw into the code that is logging */
    }
  };
  return {
    debug: call('debug'),
    info: call('info'),
    warn: call('warn'),
    error: call('error'),
    /** New logger with extra bindings on every line, e.g. log.child({requestId}). */
    child: (extra) => wrapLogger(instance.child(serialize(extra, redact)), redact, level),
    level,
    redact,
    /** The underlying pino instance (what pino-http and pino-aware libraries expect). */
    pino: instance,
  };
}

/** stdout for info/debug, stderr for warn/error/fatal (decided from the level label pino writes first on every line). */
function defaultDestination() {
  return {
    write(line) {
      const target = /^\{"level":"(warn|error|fatal)"/.test(line) ? process.stderr : process.stdout;
      target.write(line);
    },
  };
}

/**
 * Console readability: the access log becomes "GET /admin 401 15ms" and an audit entry "audit auth.login success"
 * (the JSON line keeps every field; only the terminal view is shortened).
 */
export function compactLine(line) {
  try {
    const o = JSON.parse(line);
    if (o.msg === 'request' && o.req) {
      return `${JSON.stringify({ level: o.level, time: o.time, msg: `${o.req.method} ${o.req.path} ${o.status} ${o.responseTime}ms` })}\n`;
    }
    if (o.stream === 'audit') {
      return `${JSON.stringify({ level: o.level, time: o.time, msg: `audit ${o.action} ${o.result}` })}\n`;
    }
  } catch {
    /* not JSON: leave it */
  }
  return line;
}

/**
 * Human-readable output for a terminal (pino-pretty, an optional peer/dev dependency).
 * Falls back to JSON with one warning when the package is not installed.
 */
function prettyDestination() {
  try {
    const mod = createRequire(import.meta.url)('pino-pretty');
    const opts = { colorize: true, sync: true, singleLine: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,app' };
    // Through process.stdout.write (not straight to the file descriptor), so a live console can keep its fixed part in place.
    if (typeof mod.prettyFactory === 'function') {
      const render = mod.prettyFactory(opts);
      return { write: (line) => { const text = render(compactLine(line)); if (text) process.stdout.write(text); } };
    }
    const pretty = mod({ ...opts });
    return { write: (line) => pretty.write(compactLine(line)) };
  } catch {
    // eslint-disable-next-line no-console
    console.warn('[das-forge] logs: pino-pretty is not installed, writing JSON lines instead (npm install -D pino-pretty)');
    return null;
  }
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.pretty=false] - colourised single-line output for local development (needs pino-pretty; never use in production, where the JSON lines are the contract); ignored when `stream` is given
 * @param {'debug'|'info'|'warn'|'error'|'silent'} [opts.level='info']
 * @param {{write: (line: string) => any}} [opts.stream] - default: process.stdout (process.stderr for warn/error when no stream is given)
 * @param {object} [opts.base] - bindings on every line (e.g. {app: 'workshop'})
 * @param {RegExp} [opts.redact] - keys to redact (default covers the usual credential names)
 * @param {() => Date} [opts.now] - clock, injectable for tests
 */
export function createLogger({ level = 'info', stream, pretty = false, base = {}, redact = DEFAULT_REDACT, now = () => new Date() } = {}) {
  if (!(level in LEVELS)) throw new TypeError(`createLogger: unknown level "${level}"`);

  const root = pino(
    {
      level,
      base: undefined, // no pid/hostname: bindings come from `base` below
      timestamp: () => `,"time":"${now().toISOString()}"`,
      formatters: {
        level: (label) => ({ level: label }),
        log: (fields) => serialize(fields, redact),
      },
      // Errors are already {name, message, stack, code} by the time pino
      // sees them (formatters.log); pino's own `err` serializer would
      // re-shape that plain object and drop `name`.
      serializers: { err: (value) => value },
    },
    stream ?? (pretty ? prettyDestination() : null) ?? defaultDestination()
  ).child(serialize(base, redact));

  return wrapLogger(root, redact, level);
}

/**
 * Access-log middleware (pino-http): one line per finished response -
 * message "request", `req` {id, method, path, ip, userAgent}, `status`,
 * `responseTime` (ms) - at `warn` for 4xx and `error` for
 * 5xx or a failed response. The query string is deliberately NOT logged
 * (tokens and search terms end up there) and neither are request headers
 * (cookies, authorization). Also attaches `req.log`, a child logger bound
 * to the request id, for handlers. Mount it right after requestId(); an
 * existing `req.id` is kept.
 *
 * @param {ReturnType<typeof createLogger>} logger
 * Client errors (4xx) are logged at info - a mistyped address or a missing favicon is not a warning; 5xx stay errors, 429 a warning.
 *
 * @param {{skip?: (req) => boolean, ipMode?: 'full'|'truncate'|'none'}} [opts] - e.g. skip: (req) => req.path === '/health'; ipMode shortens the logged address (`truncate`: 203.0.113.0 / 2001:db8:1::, `none`: omitted; default `full`)
 */
export function accessLog(logger, { skip, ipMode = 'full' } = {}) {
  if (!logger?.pino) throw new TypeError('accessLog: pass a logger created by createLogger()');
  const middleware = pinoHttp({
    logger: logger.pino,
    genReqId: (req) => req.id ?? uuidv4(),
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode === 429 ? 'warn' : 'info'),
    customSuccessMessage: () => 'request',
    customErrorMessage: () => 'request',
    customAttributeKeys: { reqId: 'requestId' },
    // The status comes from the raw response here: pino's standard `res`
    // serialisation reports null for it, so that key is dropped below.
    customProps: (_req, res) => ({ status: res.statusCode }),
    quietReqLogger: true,
    autoLogging: { ignore: (req) => skip?.(req) === true },
    // Works whether pino-http hands over the raw request or its default serialisation of it.
    serializers: {
      req: (r) => ({
        id: r.id,
        method: r.method,
        path: String(r.originalUrl ?? r.url ?? '').split('?')[0],
        ip: anonymizeIp(r.ip ?? r.remoteAddress ?? r.socket?.remoteAddress, ipMode),
        userAgent: r.headers?.['user-agent'],
      }),
      res: () => undefined,
    },
  });
  // Handlers get this module's logger API (log.info('msg', {fields})), not bare pino's.
  return (req, res, next) =>
    middleware(req, res, (err) => {
      if (req.log) req.log = wrapLogger(req.log, logger.redact, logger.level);
      next(err);
    });
}
