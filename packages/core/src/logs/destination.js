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
    const sink = make(driver, { ...buffer, spill, warn });
    return { type, streams: streams ? new Set(streams) : null, min: minLevel ? LEVEL_RANK[minLevel] : 0, sink };
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
    flush: () => Promise.all(built.map((s) => s.sink.flush())),
    /** Last-chance delivery, then closes every sink. Call on shutdown. */
    close: (opts) => Promise.all(built.map((s) => s.sink.close(opts))),
  };
}
