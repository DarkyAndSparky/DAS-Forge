import path from 'node:path';
import { getNextRun } from './cron-parse.js';
import { acquireFileLock } from './file-lock.js';

/**
 * Cron-driven job scheduler built on setTimeout chains (compute next
 * run time, sleep until then, run, reschedule) rather than a 1-second
 * polling loop - simpler and precise enough for the app-level jobs
 * this is for (backups, cleanup), not sub-second real-time triggers.
 *
 * Overlap protection: if a job's previous run is still in progress
 * when its next scheduled time arrives, that tick is SKIPPED (not
 * queued) - a long-running backup should never stack up a backlog of
 * pending runs. The skip is logged so silent misses are still visible.
 *
 * One job throwing (or its promise rejecting) never stops the
 * scheduler or any other registered job - each run is isolated in its
 * own try/catch, same error-isolation principle as core/realtime's
 * event bus.
 */
/** setTimeout stores its delay in a signed 32-bit int; a longer delay fires
 * IMMEDIATELY (audit B15, e.g. `0 0 29 2 *` is years away). Sleep in
 * chunks of at most a day and re-check. */
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} [opts]
 * @param {string} [opts.lockDir] - when set, every run takes `<lockDir>/<job>.lock`
 *   so another process (e.g. the CLI) cannot run the same job concurrently.
 * @param {(name: string, err: Error) => void} [opts.onError] - called when a scheduled job throws (not for
 *   `rethrow` runs, whose caller sees the error); a throwing callback is ignored. Wire `alerts.onJobError` here.
 * @param {{get:(name:string)=>string|null,set:(name:string,iso:string)=>void}} [opts.lastRunStore]
 *   - persists last-run times; required for per-job `catchUp`.
 */
export function createScheduler({ lockDir, lastRunStore, onError } = {}) {
  /** @type {Map<string, {expression:string, handler:Function, timer:NodeJS.Timeout|null, running:boolean, lastError:Error|null, lastRunAt:Date|null}>} */
  const jobs = new Map();
  let started = false;

  /** One guarded run: overlap check, cross-process lock, last-run record, error isolation. */
  async function execute(name, { rethrow = false } = {}) {
    const job = jobs.get(name);
    if (!job) return;
    if (job.running) {
      if (rethrow) throw new Error(`Job "${name}" is already running`);
      // eslint-disable-next-line no-console
      console.warn(`[das-forge] scheduler: skipping overlapping run of job "${name}"`);
      return;
    }
    let release = () => {};
    if (lockDir) {
      const got = acquireFileLock(path.join(lockDir, `${name}.lock`));
      if (!got) {
        if (rethrow) throw new Error(`Job "${name}" is running in another process`);
        // eslint-disable-next-line no-console
        console.warn(`[das-forge] scheduler: job "${name}" is locked by another process, skipping`);
        return;
      }
      release = got;
    }
    job.running = true;
    job.lastRunAt = new Date();
    try {
      lastRunStore?.set(name, job.lastRunAt.toISOString());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[das-forge] scheduler: could not record last run of "${name}":`, err);
    }
    let settle;
    job.done = new Promise((resolve) => (settle = resolve));
    try {
      await job.handler();
      job.lastError = null;
    } catch (err) {
      job.lastError = err;
      if (rethrow) throw err;
      // eslint-disable-next-line no-console
      console.error(`[das-forge] scheduler: job "${name}" threw:`, err);
      try { void Promise.resolve(onError?.(name, err)).catch(() => {}); } catch { /* a faulty callback must not break the scheduler */ }
    } finally {
      job.running = false;
      release();
      settle();
    }
  }

  function schedule(name) {
    const job = jobs.get(name);
    if (!job || !started) return;

    const nextRun = getNextRun(job.expression, new Date(), { timezone: job.timezone });
    const delayMs = nextRun.getTime() - Date.now();

    job.timer = setTimeout(async () => {
      if (!started) return;
      if (Date.now() < nextRun.getTime() - 1000) {
        // woke from a capped sleep (or the clock moved): keep waiting
        schedule(name);
        return;
      }
      await execute(name);
      schedule(name);
    }, Math.min(Math.max(delayMs, 0), MAX_TIMER_MS));
    job.timer.unref?.(); // don't keep the process alive solely for scheduling
  }

  /**
   * @param {string} name - unique job name
   * @param {string} cronExpression - 5-field cron string
   * @param {() => Promise<void>|void} handler
   * @param {object} [options]
   * @param {string} [options.timezone] - IANA zone for the cron fields (default: process local time)
   * @param {boolean} [options.catchUp] - on start(), run once immediately if a scheduled
   *   time passed since the recorded last run (needs `lastRunStore`; never on a job's first ever start)
   */
  function registerJob(name, cronExpression, handler, { timezone, catchUp = false } = {}) {
    if (jobs.has(name)) {
      throw new Error(`Job "${name}" is already registered`);
    }
    // Validate the expression eagerly (fails fast at registration,
    // not at the first scheduling attempt which could be much later).
    getNextRun(cronExpression, new Date(), { timezone });
    if (catchUp && !lastRunStore) throw new Error(`Job "${name}": catchUp needs a lastRunStore`);

    jobs.set(name, {
      expression: cronExpression,
      defaultExpression: cronExpression,
      timezone,
      catchUp,
      handler,
      timer: null,
      running: false,
      done: null,
      lastError: null,
      lastRunAt: null,
    });
    if (started) schedule(name);
  }

  function unregisterJob(name) {
    const job = jobs.get(name);
    if (job?.timer) clearTimeout(job.timer);
    jobs.delete(name);
  }

  /** Moves a registered job to another schedule (5-field cron); throws on a bad expression and leaves the job as it was. */
  function reschedule(name, cronExpression) {
    const job = jobs.get(name);
    if (!job) throw new Error(`Unknown job "${name}"`);
    getNextRun(cronExpression, new Date(), { timezone: job.timezone });
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    job.expression = cronExpression;
    if (started) schedule(name);
  }

  function start() {
    if (started) return;
    started = true;
    for (const [name, job] of jobs) {
      if (job.catchUp && missedRun(job, name)) {
        // eslint-disable-next-line no-console
        console.warn(`[das-forge] scheduler: catching up missed run of job "${name}"`);
        execute(name).finally(() => schedule(name));
      } else {
        schedule(name);
      }
    }
  }

  function missedRun(job, name) {
    let last;
    try {
      last = lastRunStore.get(name);
    } catch {
      return false;
    }
    if (!last) return false; // first start ever: nothing was "missed"
    const since = new Date(last);
    if (Number.isNaN(since.getTime())) return false;
    return getNextRun(job.expression, since, { timezone: job.timezone }).getTime() <= Date.now();
  }

  /**
   * Stops scheduling. Returns a promise that resolves once any job that
   * is running RIGHT NOW has finished, so a shutdown can await it before
   * closing the database under a half-done backup (audit B15). Callers
   * that don't care may ignore the promise.
   */
  function stop() {
    started = false;
    const inFlight = [];
    for (const job of jobs.values()) {
      if (job.timer) clearTimeout(job.timer);
      job.timer = null;
      if (job.running && job.done) inFlight.push(job.done);
    }
    return Promise.all(inFlight).then(() => undefined);
  }

  /** Runs a registered job immediately, ignoring its schedule (e.g. "run backup now" admin action). Still respects overlap protection. */
  async function runNow(name) {
    if (!jobs.has(name)) throw new Error(`Unknown job "${name}"`);
    await execute(name, { rethrow: true });
  }

  function getJobStatus(name) {
    const job = jobs.get(name);
    if (!job) return null;
    return {
      name,
      expression: job.expression,
      defaultExpression: job.defaultExpression,
      running: job.running,
      lastRunAt: job.lastRunAt,
      lastError: job.lastError?.message ?? null,
    };
  }

  function listJobs() {
    return Array.from(jobs.keys()).map(getJobStatus);
  }

  return { registerJob, unregisterJob, reschedule, start, stop, runNow, getJobStatus, listJobs };
}
