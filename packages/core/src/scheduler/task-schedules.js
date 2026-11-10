import { ensureSettingsTable } from '../branding/company-branding.js';
import { getNextRun } from './cron-parse.js';
import { dailyCron } from './schedule-setting.js';

/** Thrown for a bad value of `set()`; `code` is CRON_INVALID or UNKNOWN. */
export class TaskScheduleError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'TaskScheduleError';
    this.code = code;
  }
}

const KEY = (name) => `task_schedule:${name}`;

/**
 * Lets the administrator move any scheduler job to another schedule without touching code or configuration.
 * The override lives in `app_settings` (`task_schedule:<job>`), survives a restart and can be reset to the schedule
 * the job was registered with. Call `apply()` once after every job is registered and before `scheduler.start()`.
 * A job that has its own on/off switch (`createScheduleSetting`) is managed there, not here.
 *
 * @param {{db: object, scheduler: {listJobs: Function, reschedule: Function}}} o
 */
export function createTaskSchedules({ db, scheduler } = {}) {
  if (!db || !scheduler) throw new TypeError('createTaskSchedules: db and scheduler are required');

  function stored(name) {
    try {
      ensureSettingsTable(db);
      const row = db.get('SELECT value FROM app_settings WHERE key = ?', [KEY(name)]);
      const v = row ? JSON.parse(row.value) : null;
      return typeof v?.schedule === 'string' ? v.schedule : null;
    } catch { return null; }
  }
  const job = (name) => scheduler.listJobs().find((j) => j.name === name) ?? null;

  /** Applies every stored override to the registered jobs; a bad stored value is skipped, the job keeps its own schedule. */
  function apply() {
    for (const j of scheduler.listJobs()) {
      const expr = stored(j.name);
      if (!expr) continue;
      try { scheduler.reschedule(j.name, expr); } catch { /* keep the registered schedule */ }
    }
  }

  /** `{ cron }` (5 fields) or `{ time: 'HH:MM' }` (every day). */
  function set(name, { cron, time } = {}) {
    if (!job(name)) throw new TaskScheduleError('UNKNOWN', `Unknown task "${name}"`);
    let expr;
    try { expr = time ? dailyCron(time) : String(cron ?? '').trim().replace(/\s+/g, ' '); getNextRun(expr, new Date()); } catch (err) {
      throw new TaskScheduleError('CRON_INVALID', err?.message);
    }
    scheduler.reschedule(name, expr);
    ensureSettingsTable(db);
    db.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [KEY(name), JSON.stringify({ schedule: expr })]);
    return expr;
  }

  /** Back to the schedule the job was registered with. */
  function reset(name) {
    const j = job(name);
    if (!j) throw new TaskScheduleError('UNKNOWN', `Unknown task "${name}"`);
    ensureSettingsTable(db);
    db.run('DELETE FROM app_settings WHERE key = ?', [KEY(name)]);
    scheduler.reschedule(name, j.defaultExpression);
    return j.defaultExpression;
  }

  const isOverridden = (name) => stored(name) !== null;

  return { apply, set, reset, isOverridden };
}
