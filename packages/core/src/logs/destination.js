import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  LEVEL_RANK,
  createFileSink,
  createHttpSink,
  createStdoutSink,
  createSyslogSink,
  levelOfLine,
} from './sinks.js';

/**
 * Which stream a finished log line belongs to: an explicit `"stream":"..."` field
 * (e.g. `logger.child({stream: 'audit'})`), else access-log lines (message "request"),
 * else `app`. Done on the text, so routing costs no JSON parse per line.
 */
export function streamOfLine(line) {
  const explicit = /"stream":"([a-z][a-z0-9_-]*)"/.exec(line);
  if (explicit) return explicit[1];
  return line.includes('"msg":"request"') ? 'access' : 'app';
}

export const STREAMS = ['app', 'access', 'audit', 'security'];

/** Where a sink writes, for people to read: never a header, a password or a query string. */
function describeTarget(type, conf) {
  try {
    if (type === 'file') return String(conf.path ?? '');
    if (type === 'syslog') return `${conf.protocol ?? conf.transport ?? 'udp'}://${conf.host ?? 'localhost'}:${conf.port ?? 514}`;
    if (type === 'http') {
      const u = new URL(String(conf.url));
      return `${u.origin}${u.pathname}`;
    }
  } catch {
    /* an unparsable address is reported by the sink itself */
  }
  return type === 'stdout' ? 'stdout' : '';
}

const FACTORIES = {
  stdout: () => createStdoutSink(),
  file: (c, b) => createFileSink({ file: c.path, maxBytes: c.maxBytes, keep: c.keep, ...b }),
  syslog: (c, b) => createSyslogSink({ ...c, ...b }),
  http: (c, b) => createHttpSink({ ...c, ...b }),
};

/**
 * Builds the object pino writes to (`{write(line)}`): every line goes to each sink whose
 * `streams` and `minLevel` accept it. A broken sink never affects the others or the app.
 *
 * @param {object} opts
 * @param {Array<object>} opts.sinks - `[{type: 'stdout'|'file'|'syslog'|'http', streams?: string[], minLevel?: string, ...driver options}]`
 * @param {object} [opts.buffer] - `{maxLines, batchSize, flushIntervalMs, onFull, retryBaseMs, retryMaxMs}` for every network/file sink
 * @param {{path: string, maxBytes?: number}} [opts.localFallback] - lines a full buffer would drop are appended here (0600, capped)
 * @param {string} [opts.appName] - syslog APP-NAME / default Loki label
 * @param {object} [opts.env] - for `env:NAME` references
 * @param {(msg: string) => void} [opts.warn]
 */
export function createLogDestination({ sinks = [], buffer = {}, localFallback, appName, env = process.env, warn = (m) => console.warn(m) } = {}) { // eslint-disable-line no-console
  if (!Array.isArray(sinks) || sinks.length === 0) throw new TypeError('createLogDestination: at least one sink is required');

  let fallbackBytes = 0;
  if (localFallback?.path) {
    try {
      fallbackBytes = statSync(localFallback.path).size;
    } catch {
      /* not there yet */
    }
  }
  const spill = localFallback?.path
    ? (lines) => {
        const data = lines.map((l) => (l.endsWith('\n') ? l : `${l}\n`)).join('');
        const cap = localFallback.maxBytes ?? 50 * 1024 * 1024;
        if (fallbackBytes + Buffer.byteLength(data) > cap) throw new Error('local fallback is full');
        mkdirSync(path.dirname(path.resolve(localFallback.path)), { recursive: true });
        appendFileSync(localFallback.path, data, { mode: 0o600 });
        fallbackBytes += Buffer.byteLength(data);
      }
    : undefined;

  const built = sinks.map((conf) => {
    const make = FACTORIES[conf.type];
    if (!make) throw new TypeError(`log sink: unknown type "${conf.type}" (use stdout, file, syslog or http)`);
    const { type, streams, minLevel, ...driver } = conf;
    if (minLevel && !(minLevel in LEVEL_RANK)) throw new TypeError(`log sink: unknown minLevel "${minLevel}"`);
    for (const s of streams ?? []) if (typeof s !== 'string' || s === '') throw new TypeError('log sink: streams must be non-empty strings');
    if (driver.headers) driver.env = env;
    if (type === 'syslog') {
      driver.appName ??= appName;
      if (driver.caFile) driver.ca = readFileSync(driver.caFile);
      delete driver.caFile;
    }
    if (type === 'http' && appName && !driver.labels) driver.labels = { app: appName };
    const target = describeTarget(type, conf);
    const sink = make(driver, { ...buffer, spill, warn });
    return { type, target, minLevel: minLevel ?? null, streams: streams ? new Set(streams) : null, min: minLevel ? LEVEL_RANK[minLevel] : 0, sink };
  });

  return {
    write(line) {
      const stream = streamOfLine(line);
      const rank = LEVEL_RANK[levelOfLine(line)] ?? 20;
      for (const s of built) {
        if (s.streams && !s.streams.has(stream)) continue;
        if (rank < s.min) continue;
        try {
          s.sink.write(line);
        } catch {
          /* a logger never throws */
        }
      }
    },
    /** Delivery counters per sink: sent, dropped, spilled, queued, failures, lastError. */
    stats: () => built.map((s) => ({ type: s.type, ...s.sink.stats() })),
    /** What each sink is: type, where it writes (no credentials, no query string), the streams and minimum level it takes. */
    describe: () => built.map((s) => ({ type: s.type, target: s.target, streams: s.streams ? [...s.streams] : null, minLevel: s.minLevel })),
    /**
     * Sends one test line straight into every sink (filters bypassed) and waits for delivery, at most `timeoutMs` each.
     * @returns {Promise<Array<{type: string, target: string, ok: boolean, error?: string}>>}
     */
    async test({ timeoutMs = 10_000 } = {}) {
      const line = JSON.stringify({ level: 30, time: Date.now(), msg: 'das-forge log sink test', stream: 'app', test: true });
      return Promise.all(built.map(async (s) => {
        const base = { type: s.type, target: s.target };
        try {
          const before = s.sink.stats();
          s.sink.write(line);
          let timer;
          const timeout = new Promise((r) => { timer = setTimeout(() => r('timeout'), timeoutMs); timer.unref?.(); });
          const outcome = await Promise.race([s.sink.flush().then(() => 'done'), timeout]);
          clearTimeout(timer);
          const after = s.sink.stats();
          if (typeof after.sent !== 'number') return { ...base, ok: true }; // stdout: nothing to count
          if (after.sent > before.sent) return { ...base, ok: true };
          return { ...base, ok: false, error: outcome === 'timeout' ? 'timeout' : String(after.lastError ?? 'not delivered') };
        } catch (err) {
          return { ...base, ok: false, error: String(err?.message ?? err) };
        }
      }));
    },
    flush: () => Promise.all(built.map((s) => s.sink.flush())),
    /** Last-chance delivery, then closes every sink. Call on shutdown. */
    close: (opts) => Promise.all(built.map((s) => s.sink.close(opts))),
  };
}
