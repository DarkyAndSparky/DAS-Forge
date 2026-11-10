import { assertOutboundUrl } from '../http/outbound.js';
import dgram from 'node:dgram';
import { appendFile, rename, rm, stat, mkdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { backoffDelay } from '../util/backoff.js';

/**
 * Log sinks: where finished log lines go (audit 0.1.81 - logs must be able to
 * leave the machine, because whoever takes over the host can delete local files).
 *
 * Every network/file sink is wrapped in a BOUNDED, ASYNCHRONOUS buffer
 * (`createBufferedSink`): writing a log line never waits for the network and never
 * throws; a slow or dead destination makes lines queue up to `maxLines`, then the
 * overflow policy applies (drop the oldest, or the newest, optionally spilling to a
 * local fallback file) and the drops are COUNTED, not silent (`stats()`).
 *
 * No third-party packages: node:net / node:tls / node:dgram / fetch / node:fs.
 */

const SEVERITY = { debug: 7, info: 6, warn: 4, error: 3, fatal: 2 };
const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

export const levelOfLine = (line) => /"level":"(debug|info|warn|error|fatal)"/.exec(line)?.[1] ?? 'info';
const stripEol = (line) => line.replace(/\r?\n$/, '');

/** `env:NAME` -> process.env.NAME (throws when unset); anything else is returned as is. */
export function resolveEnvRef(value, env = process.env) {
  if (typeof value !== 'string' || !value.startsWith('env:')) return value;
  const name = value.slice(4);
  const v = env[name];
  if (v === undefined || v === '') throw new Error(`log sink: environment variable ${name} is not set`);
  return v;
}

/**
 * @param {object} o
 * @param {string} o.name
 * @param {(lines: string[]) => Promise<void>} o.send - delivers one batch; throws to signal "try again"; throw an error with `permanent: true` to drop the batch
 * @param {() => Promise<void>} [o.close] - closes the transport
 * @param {number} [o.maxLines=10000]
 * @param {number} [o.batchSize=100]
 * @param {number} [o.flushIntervalMs=1000]
 * @param {number} [o.retryBaseMs=1000]
 * @param {number} [o.retryMaxMs=60000]
 * @param {'drop-oldest'|'drop-newest'} [o.onFull='drop-oldest']
 * @param {(lines: string[]) => void} [o.spill] - receives lines the buffer had to drop (local fallback)
 * @param {(msg: string) => void} [o.warn]
 */
export function createBufferedSink({
  name,
  send,
  close,
  maxLines = 10_000,
  batchSize = 100,
  flushIntervalMs = 1000,
  retryBaseMs = 1000,
  retryMaxMs = 60_000,
  onFull = 'drop-oldest',
  spill,
  warn = (m) => console.warn(m), // eslint-disable-line no-console
} = {}) {
  let queue = [];
  let timer = null;
  let inFlight = null;
  let failures = 0;
  let closed = false;
  const stats = { name, sent: 0, dropped: 0, spilled: 0, queued: 0, failures: 0, lastError: null, lastSuccessAt: null };

  const overflow = (lines) => {
    if (lines.length === 0) return;
    if (spill) {
      try {
        spill(lines);
        stats.spilled += lines.length;
        return;
      } catch {
        /* fall through to a plain drop */
      }
    }
    stats.dropped += lines.length;
  };

  function schedule(delay) {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delay);
    timer.unref?.();
  }

  async function flush() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      while (queue.length > 0) {
        // The batch leaves the queue while it is being sent, so overflow handling on the
        // front of the queue (drop-oldest) can never shift lines under a running send.
        const batch = queue.splice(0, batchSize);
        try {
          await send(batch);
          stats.sent += batch.length;
          stats.lastSuccessAt = new Date().toISOString();
          if (failures > 0) warn(`[das-forge] log sink "${name}" recovered`);
          failures = 0;
        } catch (err) {
          stats.failures++;
          stats.lastError = String(err?.message ?? err);
          if (err?.permanent) {
            // the destination will never accept this batch (e.g. HTTP 400): drop it, do not retry forever
            stats.dropped += batch.length;
            warn(`[das-forge] log sink "${name}" rejected a batch for good (${stats.lastError}); ${batch.length} line(s) dropped`);
            continue;
          }
          queue.unshift(...batch);
          if (queue.length > maxLines) {
            const excess = queue.length - maxLines;
            overflow(onFull === 'drop-newest' ? queue.splice(maxLines, excess) : queue.splice(0, excess));
          }
          failures++;
          if (failures === 1) warn(`[das-forge] log sink "${name}" is failing (${stats.lastError}); buffering up to ${maxLines} line(s)`);
          schedule(backoffDelay(Math.min(failures, 11), { baseMs: retryBaseMs, maxMs: retryMaxMs }));
          return;
        }
      }
    })().finally(() => {
      inFlight = null;
      stats.queued = queue.length;
    });
    return inFlight;
  }

  return {
    name,
    write(line) {
      if (closed) return;
      if (queue.length >= maxLines) {
        if (onFull === 'drop-newest') return overflow([line]);
        overflow(queue.splice(0, Math.max(1, Math.ceil(maxLines / 10)))); // drop a tenth at once, not one line per write
      }
      queue.push(line);
      stats.queued = queue.length;
      if (queue.length >= batchSize) void flush();
      else schedule(flushIntervalMs);
    },
    flush,
    stats: () => ({ ...stats, queued: queue.length }),
    /** Last chance delivery, bounded by `timeoutMs`; whatever is left is spilled (or dropped) and counted. */
    async close({ timeoutMs = 3000 } = {}) {
      if (timer) clearTimeout(timer);
      timer = null;
      await Promise.race([flush().catch(() => {}), new Promise((r) => setTimeout(r, timeoutMs).unref?.())]);
      closed = true;
      overflow(queue.splice(0));
      try {
        await close?.();
      } catch {
        /* closing is best effort */
      }
    },
  };
}

/** stdout for info/debug, stderr for warn and above (what the default logger did). */
export function createStdoutSink() {
  return {
    name: 'stdout',
    write(line) {
      try {
        (/"level":"(warn|error|fatal)"/.test(line) ? process.stderr : process.stdout).write(line);
      } catch {
        /* a logger never throws */
      }
    },
    flush: async () => {},
    stats: () => ({ name: 'stdout' }),
    close: async () => {},
  };
}

/**
 * Appends lines to a file (a mounted network share, another disk). Mode 0600;
 * `maxBytes` > 0 rotates to `<file>.1 ... <file>.<keep>` before growing past it.
 */
export function createFileSink({ file, maxBytes = 0, keep = 5, ...bufferOptions }) {
  if (!file) throw new TypeError('file sink: "path" is required');
  const target = path.resolve(file);
  let prepared = false;

  async function rotate() {
    for (let i = keep; i >= 1; i--) {
      const from = i === 1 ? target : `${target}.${i - 1}`;
      await rename(from, `${target}.${i}`).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
  }

  return createBufferedSink({
    name: `file:${file}`,
    ...bufferOptions,
    async send(lines) {
      if (!prepared) {
        await mkdir(path.dirname(target), { recursive: true });
        prepared = true;
      }
      const data = lines.map((l) => (l.endsWith('\n') ? l : `${l}\n`)).join('');
      if (maxBytes > 0) {
        const size = await stat(target).then((s) => s.size, () => 0);
        if (size > 0 && size + Buffer.byteLength(data) > maxBytes) {
          if (keep > 0) await rotate();
          else await rm(target, { force: true });
        }
      }
      await appendFile(target, data, { mode: 0o600 });
    },
  });
}

/** RFC 5424 message: `<PRI>1 TIME HOST APP PROCID MSGID - MSG` (structured data is "-"; the JSON line is the message). */
export function formatSyslog(line, { facility = 16, appName = 'das-forge', hostname = os.hostname(), pid = process.pid, now = () => new Date() } = {}) {
  const sev = SEVERITY[levelOfLine(line)] ?? 6;
  const clean = (s, n) => String(s).replace(/[^\x21-\x7e]/g, '_').slice(0, n) || '-';
  return `<${facility * 8 + sev}>1 ${now().toISOString()} ${clean(hostname, 255)} ${clean(appName, 48)} ${pid} - - ${stripEol(line)}`;
}

/**
 * syslog over UDP, TCP (octet-counted frames, RFC 6587) or TLS.
 * TLS verifies the server certificate by default (`ca` adds a private CA).
 */
export function createSyslogSink({
  host,
  port,
  protocol = 'udp',
  ca,
  rejectUnauthorized = true,
  facility = 16,
  appName,
  hostname,
  connectTimeoutMs = 5000,
  ...bufferOptions
}) {
  if (!host) throw new TypeError('syslog sink: "host" is required');
  const portNumber = port ?? (protocol === 'tls' ? 6514 : 514);
  const fmt = (line) => formatSyslog(line, { facility, appName, hostname });
  let socket = null;
  let udp = null;

  function connect() {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        socket?.destroy();
        socket = null;
        reject(err);
      };
      const options = { host, port: portNumber, timeout: connectTimeoutMs };
      const s = protocol === 'tls' ? tls.connect({ ...options, servername: net.isIP(host) ? undefined : host, ca, rejectUnauthorized }) : net.connect(options);
      socket = s;
      s.once('error', onError);
      s.once('timeout', () => onError(new Error(`syslog connect/idle timeout to ${host}:${portNumber}`)));
      s.once(protocol === 'tls' ? 'secureConnect' : 'connect', () => {
        s.setTimeout(0);
        s.off('error', onError);
        s.on('error', () => {
          s.destroy();
          if (socket === s) socket = null;
        });
        s.on('close', () => {
          if (socket === s) socket = null;
        });
        resolve(s);
      });
    });
  }

  return createBufferedSink({
    name: `syslog:${protocol}://${host}:${portNumber}`,
    ...bufferOptions,
    async send(lines) {
      if (protocol === 'udp') {
        udp ??= dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
        for (const line of lines) {
          const msg = Buffer.from(fmt(line).slice(0, 8000));
          await new Promise((resolve, reject) => udp.send(msg, portNumber, host, (err) => (err ? reject(err) : resolve())));
        }
        return;
      }
      const s = socket && !socket.destroyed ? socket : await connect();
      const payload = lines
        .map((l) => {
          const m = fmt(l);
          return `${Buffer.byteLength(m)} ${m}`;
        })
        .join('');
      await new Promise((resolve, reject) => s.write(payload, (err) => (err ? reject(err) : resolve())));
    },
    async close() {
      socket?.end();
      socket?.destroy();
      socket = null;
      udp?.close();
      udp = null;
    },
  });
}

const HTTP_FORMATS = {
  /** one JSON line per log line (Vector, Fluent Bit, Logstash http input, any NDJSON endpoint) */
  ndjson: (lines) => ({ type: 'application/x-ndjson', body: lines.map(stripEol).join('\n') + '\n' }),
  /** Grafana Loki push API; `labels` identify the stream */
  loki: (lines, { labels }) => ({
    type: 'application/json',
    body: JSON.stringify({
      streams: [{ stream: labels, values: lines.map((l, i) => [String((Date.now() - (lines.length - i)) * 1_000_000), stripEol(l)]) }],
    }),
  }),
  /** Elasticsearch / OpenSearch `_bulk` */
  'elastic-bulk': (lines, { index }) => ({
    type: 'application/x-ndjson',
    body: lines.map((l) => `{"index":{"_index":${JSON.stringify(index)}}}\n${stripEol(l)}\n`).join(''),
  }),
  /** Splunk HTTP Event Collector: concatenated `{"event": ...}` objects */
  'splunk-hec': (lines, { source }) => ({
    type: 'application/json',
    body: lines
      .map((l) => {
        let event;
        try {
          event = JSON.parse(l);
        } catch {
          event = stripEol(l);
        }
        return JSON.stringify({ time: Date.now() / 1000, source, event });
      })
      .join(''),
  }),
};

export const HTTP_SINK_FORMATS = Object.keys(HTTP_FORMATS);

/**
 * HTTP(S) delivery (Loki, Elasticsearch/OpenSearch, Splunk HEC, any NDJSON receiver).
 * 5xx, 408, 429 and network errors are retried; any other 4xx drops the batch (it would never succeed).
 * Header values may be `env:NAME`. `fetchImpl` is injectable for tests.
 */
export function createHttpSink({
  url,
  format = 'ndjson',
  headers = {},
  labels = { app: 'das-forge' },
  index = 'das-forge-logs',
  source = 'das-forge',
  timeoutMs = 5000,
  fetchImpl = globalThis.fetch,
  env = process.env,
  ...bufferOptions
}) {
  if (!url) throw new TypeError('http sink: "url" is required');
  assertOutboundUrl(url, { label: 'http sink', protocols: ['https:', 'http:'] });
  const build = HTTP_FORMATS[format];
  if (!build) throw new TypeError(`http sink: unknown format "${format}" (use ${HTTP_SINK_FORMATS.join(', ')})`);
  const resolved = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, resolveEnvRef(v, env)]));

  return createBufferedSink({
    name: `http:${new URL(url).host}`,
    ...bufferOptions,
    async send(lines) {
      const { type, body } = build(lines, { labels, index, source });
      let res;
      try {
        res = await fetchImpl(url, { method: 'POST', redirect: 'error', headers: { 'content-type': type, ...resolved }, body, signal: AbortSignal.timeout(timeoutMs) }); // no redirects: a collector must not send the server on to another address
      } catch (err) {
        throw new Error(`http sink: ${err?.cause?.code ?? err?.message ?? err}`);
      }
      if (res.ok) return;
      const err = new Error(`http sink: HTTP ${res.status}`);
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) err.permanent = true;
      throw err;
    },
  });
}

export { LEVEL_RANK };
