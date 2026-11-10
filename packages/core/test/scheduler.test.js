import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseCron, getNextRun } from '../src/scheduler/cron-parse.js';
import { createScheduler } from '../src/scheduler/scheduler.js';
import { createBackupJob } from '../src/scheduler/backup-job.js';
import { createSqliteAdapter } from '../src/database/index.js';

describe('parseCron / getNextRun', () => {
  it('finds the next 3am run for the default backup schedule "0 3 * * *"', () => {
    const from = new Date(2026, 0, 1, 10, 0, 0); // Jan 1 2026, 10:00 (after 3am)
    const next = getNextRun('0 3 * * *', from);
    expect(next.getHours()).toBe(3);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(2); // next day, since 3am today already passed
  });

  it('finds later today if the time has not passed yet', () => {
    const from = new Date(2026, 0, 1, 1, 0, 0); // 1am, before 3am
    const next = getNextRun('0 3 * * *', from);
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(3);
  });

  it('supports step expressions ("*/15")', () => {
    const from = new Date(2026, 0, 1, 10, 1, 0);
    const next = getNextRun('*/15 * * * *', from);
    expect(next.getMinutes()).toBe(15);
  });

  it('supports lists and ranges', () => {
    const parsed = parseCron('0 9-17 * * 1-5'); // business hours, weekdays
    expect(parsed.hour.has(9)).toBe(true);
    expect(parsed.hour.has(8)).toBe(false);
    expect(parsed.dayOfWeek.has(1)).toBe(true);
    expect(parsed.dayOfWeek.has(0)).toBe(false);
  });

  it('applies OR semantics when both day-of-month and day-of-week are restricted', () => {
    // "on the 1st OR on Mondays" - classic cron gotcha
    const from = new Date(2026, 0, 5, 0, 0, 0); // Jan 5 2026 is a Monday
    const next = getNextRun('0 0 1 * 1', from);
    // Should hit the next Monday (Jan 12), not wait for day 1 of next month
    expect(next.getDay()).toBe(1);
  });

  it('throws on a malformed expression (wrong field count)', () => {
    expect(() => parseCron('0 3 * *')).toThrow(/5 fields/);
  });

  it('throws on an out-of-range value', () => {
    expect(() => parseCron('99 3 * * *')).toThrow(/out of range/);
  });
});

describe('createScheduler', () => {
  // A fixed start (on a minute boundary + 10 s): with the real clock a start at :59 let two cron ticks fit into 61 s.
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 0, 1, 10, 0, 10)); });
  afterEach(() => vi.useRealTimers());

  it('runs a job at its scheduled time', async () => {
    const scheduler = createScheduler();
    const handler = vi.fn();
    scheduler.registerJob('test-job', '* * * * *', handler); // every minute
    scheduler.start();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(handler).toHaveBeenCalled();
    scheduler.stop();
  });

  it('rejects registering the same job name twice', () => {
    const scheduler = createScheduler();
    scheduler.registerJob('dup', '* * * * *', () => {});
    expect(() => scheduler.registerJob('dup', '* * * * *', () => {})).toThrow(/already registered/);
  });

  it('rejects an invalid cron expression at registration time', () => {
    const scheduler = createScheduler();
    expect(() => scheduler.registerJob('bad', 'not a cron', () => {})).toThrow();
  });

  it('skips an overlapping run instead of queueing it', async () => {
    const scheduler = createScheduler();
    let concurrentRuns = 0;
    let maxConcurrent = 0;
    const handler = vi.fn(async () => {
      concurrentRuns++;
      maxConcurrent = Math.max(maxConcurrent, concurrentRuns);
      await new Promise((resolve) => setTimeout(resolve, 90_000)); // longer than its own interval
      concurrentRuns--;
    });

    scheduler.registerJob('slow-job', '* * * * *', handler);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(61_000); // first run starts
    await vi.advanceTimersByTimeAsync(61_000); // second tick while first still running - should skip
    expect(maxConcurrent).toBe(1); // never ran concurrently with itself

    scheduler.stop();
  });

  it('isolates a job error - does not throw out of the scheduler, records lastError', async () => {
    const scheduler = createScheduler();
    scheduler.registerJob('failing-job', '* * * * *', () => {
      throw new Error('job boom');
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(61_000);
    const status = scheduler.getJobStatus('failing-job');
    expect(status.lastError).toBe('job boom');

    scheduler.stop();
  });

  it('reports a failed scheduled run to onError (a faulty callback is ignored); runNow errors go to the caller instead', async () => {
    const seen = [];
    const scheduler = createScheduler({ onError: (name, err) => { seen.push([name, err.message]); throw new Error('callback broke'); } });
    scheduler.registerJob('bad', '* * * * *', () => { throw new Error('boom'); });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(seen).toEqual([['bad', 'boom']]);
    expect(scheduler.getJobStatus('bad').lastError).toBe('boom');
    await expect(scheduler.runNow('bad')).rejects.toThrow('boom');
    expect(seen).toHaveLength(1);
    scheduler.stop();
  });

  it('runNow executes immediately, ignoring the schedule, and respects overlap protection', async () => {
    const scheduler = createScheduler();
    const handler = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    scheduler.registerJob('on-demand', '0 3 * * *', handler); // far in the future

    const runPromise = scheduler.runNow('on-demand');
    await expect(scheduler.runNow('on-demand')).rejects.toThrow(/already running/);
    await vi.advanceTimersByTimeAsync(10);
    await runPromise;

    expect(handler).toHaveBeenCalledOnce();
  });

  it('unregisterJob stops future runs', async () => {
    const scheduler = createScheduler();
    const handler = vi.fn();
    scheduler.registerJob('temp-job', '* * * * *', handler);
    scheduler.start();
    scheduler.unregisterJob('temp-job');

    await vi.advanceTimersByTimeAsync(120_000);
    expect(handler).not.toHaveBeenCalled();
  });

  it('listJobs reports status for all registered jobs', () => {
    const scheduler = createScheduler();
    scheduler.registerJob('a', '* * * * *', () => {});
    scheduler.registerJob('b', '0 3 * * *', () => {});
    const list = scheduler.listJobs();
    expect(list.map((j) => j.name).sort()).toEqual(['a', 'b']);
  });
});

describe('createBackupJob', () => {
  let dbDir, backupDir, dbPath, db;

  beforeEach(() => {
    dbDir = mkdtempSync(path.join(os.tmpdir(), 'dbdir-'));
    backupDir = mkdtempSync(path.join(os.tmpdir(), 'backupdir-'));
    dbPath = path.join(dbDir, 'app.db');
    db = createSqliteAdapter({ file: dbPath });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.run('INSERT INTO t (v) VALUES (?)', ['hello']);
  });

  afterEach(() => {
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  });

  it('packs the database into a single backup .zip in the local destination', async () => {
    const runBackup = createBackupJob({
      db,
      dbFilePath: dbPath,
      destinations: [{ id: 'local-1', type: 'local', path: backupDir }],
      retentionDays: 30,
    });

    const results = await runBackup();
    expect(results).toHaveLength(1);
    expect(existsSync(results[0].backupPath)).toBe(true);

    const files = readdirSync(backupDir);
    expect(files.some((f) => f.startsWith('backup-') && f.endsWith('.zip'))).toBe(true);
  });

  it('prunes local backups older than retentionDays', async () => {
    // seed an old backup file, backdated well past retention
    const oldFile = path.join(backupDir, 'backup-old.zip');
    writeFileSync(oldFile, 'old data');
    const oldTime = (Date.now() - 100 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(oldFile, oldTime, oldTime);

    const runBackup = createBackupJob({
      db,
      dbFilePath: dbPath,
      destinations: [{ id: 'local-1', type: 'local', path: backupDir }],
      retentionDays: 30,
      minKeep: 1,
    });

    const results = await runBackup();
    expect(results[0].prunedCount).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
  });

  it('throws a clear error for an unimplemented destination type (extension point)', async () => {
    const runBackup = createBackupJob({
      db,
      dbFilePath: dbPath,
      destinations: [{ id: 's3-1', type: 's3', config: {} }],
      retentionDays: 30,
    });

    await expect(runBackup()).rejects.toThrow(/not implemented/);
  });
});
