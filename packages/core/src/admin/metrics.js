/**
 * Hourly metrics: counters kept in memory and flushed to `metrics_hourly` in batches (one upsert per
 * name per hour, not one write per request). Buckets are UTC hours ("YYYY-MM-DDTHH"); old rows are
 * purged by retention. Used by the admin charts; names are free-form ("http.requests", "login.fail").
 */
import { asyncDb } from '../database/async.js';

const NAME = /^[a-zA-Z0-9._:-]{1,64}$/;
const METRICS_DDL = `CREATE TABLE IF NOT EXISTS metrics_hourly (
    bucket TEXT NOT NULL,
    name TEXT NOT NULL,
    value REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, name)
  )`;
const SET_SQL = `INSERT INTO metrics_hourly (bucket, name, value) VALUES (?, ?, ?)
           ON CONFLICT(bucket, name) DO UPDATE SET value = excluded.value`;
const ADD_SQL = `INSERT INTO metrics_hourly (bucket, name, value) VALUES (?, ?, ?)
           ON CONFLICT(bucket, name) DO UPDATE SET value = metrics_hourly.value + excluded.value`;
const ROWS_SQL = 'SELECT bucket, value FROM metrics_hourly WHERE name = ? AND bucket >= ?';
const PURGE_SQL = 'DELETE FROM metrics_hourly WHERE bucket < ?';

/** The table over `asyncDb`. Call once at start-up, outside a transaction. */
export async function ensureMetricsTableAsync(db) { await asyncDb(db).exec(METRICS_DDL); }

export function ensureMetricsTable(db) {
  db.exec(METRICS_DDL);
}

export function hourBucket(date) {
  return date.toISOString().slice(0, 13);
}

/**
 * @param {object} [o.synchronous=true] - false for an asynchronous database: nothing is created or started here; call
 *   `ensureMetricsTableAsync(db)` once and `startAsync()`, and use the `...Async` methods
 */
export function createMetrics(db, { flushMs = 10_000, retentionDays = 35, now = () => new Date(), synchronous = true } = {}) {
  if (synchronous) ensureMetricsTable(db);
  const a = asyncDb(db);
  /** @type {Map<string, number>} key = bucket|name */
  let pending = new Map();
  /** @type {Map<string, number>} gauges: the last value seen in the hour wins (key = bucket|name) */
  let pendingGauges = new Map();
  let timer = null;

  function inc(name, n = 1) {
    if (!NAME.test(name) || !Number.isFinite(n)) return;
    const k = `${hourBucket(now())}|${name}`;
    pending.set(k, (pending.get(k) ?? 0) + n);
  }

  /** Records a level (sessions, bytes, queue length): one value per hour, the latest wins. */
  function set(name, value) {
    if (!NAME.test(name) || !Number.isFinite(value)) return;
    pendingGauges.set(`${hourBucket(now())}|${name}`, value);
  }

  function flush() {
    if (pending.size === 0 && pendingGauges.size === 0) return 0;
    const batch = pending;
    pending = new Map();
    const gauges = pendingGauges;
    pendingGauges = new Map();
    try {
      db.exec('BEGIN');
      for (const [k, v] of gauges) {
        const [bucket, name] = k.split('|');
        db.run(SET_SQL, [bucket, name, v]);
      }
      for (const [k, v] of batch) {
        const [bucket, name] = k.split('|');
        db.run(ADD_SQL, [bucket, name, v]);
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
      for (const [k, v] of batch) pending.set(k, (pending.get(k) ?? 0) + v); // keep the counts
      for (const [k, v] of gauges) if (!pendingGauges.has(k)) pendingGauges.set(k, v);
      throw err;
    }
    return batch.size + gauges.size;
  }

  /** Last `hours` hourly buckets (oldest first), gaps filled with 0. */
  function series(name, { hours = 24 } = {}) {
    flush();
    const out = zeroBuckets(hours);
    return fillSeries(out, db.all(ROWS_SQL, [name, out[0].bucket]));
  }

  function zeroBuckets(hours) {
    const end = now();
    end.setUTCMinutes(0, 0, 0);
    const out = [];
    for (let i = hours - 1; i >= 0; i--) out.push({ bucket: hourBucket(new Date(end.getTime() - i * 3600_000)), value: 0 });
    return out;
  }
  function fillSeries(out, rows) {
    const byBucket = new Map(rows.map((r) => [r.bucket, r.value]));
    for (const p of out) p.value = byBucket.get(p.bucket) ?? 0;
    return out;
  }

  /** Periods of the charts: how far back and how many hours one point covers. */
  const PERIODS = { '24h': { hours: 24, step: 1 }, '7d': { hours: 168, step: 6 }, '30d': { hours: 720, step: 24 } };

  const bucketList = (hours) => zeroBuckets(hours).map((p) => p.bucket);
  const rawFrom = (buckets, rows) => {
    const byBucket = new Map(rows.map((r) => [r.bucket, r.value]));
    return buckets.map((bucket) => ({ bucket, value: byBucket.has(bucket) ? byBucket.get(bucket) : null }));
  };
  function rawRows(name, hours) {
    const buckets = bucketList(hours);
    return rawFrom(buckets, db.all(ROWS_SQL, [name, buckets[0]]));
  }

  function group(rows, step, reduce) {
    const out = [];
    for (let i = 0; i < rows.length; i += step) {
      const part = rows.slice(i, i + step);
      out.push({ bucket: part[0].bucket, value: reduce(part.map((r) => r.value)) });
    }
    return out;
  }

  /**
   * A chart-ready series for a period ('24h' | '7d' | '30d'), points oldest first.
   * mode 'sum' (counters): total per point, gaps count as 0.
   * mode 'last' (levels from `set`): the latest value in the point; a point without data is null.
   */
  function periodSeries(name, period = '24h', { mode = 'sum' } = {}) {
    flush();
    const p = PERIODS[period] ?? PERIODS['24h'];
    return groupMode(rawRows(name, p.hours), p.step, mode);
  }
  const groupMode = (rows, step, mode) => group(rows, step, mode === 'last'
    ? (vs) => { const x = vs.filter((v) => v !== null); return x.length ? x[x.length - 1] : null; }
    : (vs) => vs.reduce((a, v) => a + (v ?? 0), 0));
  const averageOf = (s, c) => s.map((p, i) => ({ bucket: p.bucket, value: c[i].value > 0 ? p.value / c[i].value : null }));

  /** Average per event: `sumName` divided by `countName` for each point (e.g. milliseconds per request); null without events. */
  function periodAverage(sumName, countName, period = '24h') {
    const s = periodSeries(sumName, period);
    const c = periodSeries(countName, period);
    return averageOf(s, c);
  }

  function purge() {
    const cutoff = hourBucket(new Date(now().getTime() - retentionDays * 86400_000));
    return db.run(PURGE_SQL, [cutoff]).changes ?? 0;
  }

  /** Express middleware: counts requests and 4xx/5xx responses. */
  function middleware() {
    return (req, res, next) => {
      const started = process.hrtime.bigint();
      res.on('finish', () => {
        inc('http.requests');
        inc('http.ms', Number(process.hrtime.bigint() - started) / 1e6);
        if (res.statusCode >= 500) inc('http.5xx');
        else if (res.statusCode >= 400) inc('http.4xx');
      });
      next();
    };
  }

  function start() {
    if (timer || flushMs <= 0) return;
    timer = setInterval(() => { try { flush(); } catch { /* retried next tick */ } }, flushMs);
    timer.unref?.();
  }
  function close() {
    if (timer) clearInterval(timer);
    timer = null;
    try { flush(); } catch { /* db already closed */ }
  }

  // The same operations over `asyncDb`.
  async function flushAsync() {
    if (pending.size === 0 && pendingGauges.size === 0) return 0;
    const batch = pending;
    pending = new Map();
    const gauges = pendingGauges;
    pendingGauges = new Map();
    try {
      await a.transaction(async (tx) => {
        for (const [k, v] of gauges) { const [bucket, name] = k.split('|'); await tx.run(SET_SQL, [bucket, name, v]); }
        for (const [k, v] of batch) { const [bucket, name] = k.split('|'); await tx.run(ADD_SQL, [bucket, name, v]); }
      });
    } catch (err) {
      for (const [k, v] of batch) pending.set(k, (pending.get(k) ?? 0) + v); // keep the counts
      for (const [k, v] of gauges) if (!pendingGauges.has(k)) pendingGauges.set(k, v);
      throw err;
    }
    return batch.size + gauges.size;
  }
  async function seriesAsync(name, { hours = 24 } = {}) {
    await flushAsync();
    const out = zeroBuckets(hours);
    return fillSeries(out, await a.all(ROWS_SQL, [name, out[0].bucket]));
  }
  async function periodSeriesAsync(name, period = '24h', { mode = 'sum' } = {}) {
    await flushAsync();
    const p = PERIODS[period] ?? PERIODS['24h'];
    const buckets = bucketList(p.hours);
    return groupMode(rawFrom(buckets, await a.all(ROWS_SQL, [name, buckets[0]])), p.step, mode);
  }
  async function periodAverageAsync(sumName, countName, period = '24h') {
    return averageOf(await periodSeriesAsync(sumName, period), await periodSeriesAsync(countName, period));
  }
  async function purgeAsync() {
    return (await a.run(PURGE_SQL, [hourBucket(new Date(now().getTime() - retentionDays * 86400_000))])).changes ?? 0;
  }
  function startAsync() {
    if (timer || flushMs <= 0) return;
    timer = setInterval(() => { void flushAsync().catch(() => { /* retried next tick */ }); }, flushMs);
    timer.unref?.();
  }
  async function closeAsync() {
    if (timer) clearInterval(timer);
    timer = null;
    try { await flushAsync(); } catch { /* db already closed */ }
  }

  if (synchronous) start();
  return { inc, set, flush, series, periodSeries, periodAverage, periods: Object.keys(PERIODS), purge, middleware, close, flushAsync, seriesAsync, periodSeriesAsync, periodAverageAsync, purgeAsync, startAsync, closeAsync };
}
