import { ensureSettingsTable } from '../branding/company-branding.js';
import { getNextRun } from './cron-parse.js';

/** Thrown for a bad value of `set()`; `code` is TIME_INVALID. */
export class ScheduleSettingError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'ScheduleSettingError';
    this.code = code;
  }
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DAILY = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;

/** 'HH:MM' -> '`M H * * *`' (every day at that time, server local time). */
export function dailyCron(time) {
  const m = TIME.exec(String(time ?? '').trim());
  if (!m) throw new ScheduleSettingError('TIME_INVALID', 'time must be HH:MM');
  return `${Number(m[2])} ${Number(m[1])} * * *`;
}

/** '`5 3 * * *`' -> '03:05'; null when the expression is not "once a day at a fixed time". */
export function timeOfDaily(cron) {
  const m = DAILY.exec(String(cron ?? '').trim());
  if (!m || Number(m[1]) > 59 || Number(m[2]) > 23) return null;
  return `${String(m[2]).padStart(2, '0')}:${String(m[1]).padStart(2, '0')}`;
}

/**
 * A job whose on/off switch and daily time the administrator can change while the application runs.
 * The setting lives in the database (`app_settings`, key `schedule:<key>`), so it survives a restart; until it
 * is changed, the configuration file's values (`defaults`) apply. `apply()` (call once at start, after the scheduler
 * is created) and every `set()` register the job on the scheduler, or remove it when switched off.
 *
 * @param {object} o
 * @param {object} o.db
 * @param {{registerJob: Function, unregisterJob: Function}} o.scheduler
 * @param {string} o.key - setting name, e.g. 'doctor'
 * @param {string} o.jobName - the scheduler job to manage
 * @param {() => any} o.handler - what the job runs
 * @param {{enabled: boolean, schedule: string}} o.defaults - from the configuration (`schedule`: 5-field cron)
 * @param {object} [o.registerOptions] - passed on to `registerJob` (e.g. `{ catchUp: true }`)
 */
export function createScheduleSetting({ db, scheduler, key, jobName, handler, defaults, registerOptions = {} } = {}) {
  if (!db || !scheduler || !key || !jobName || typeof handler !== 'function') throw new TypeError('createScheduleSetting: db, scheduler, key, jobName and handler are required');
  const storeKey = `schedule:${key}`;

  function stored() {
    try {
      ensureSettingsTable(db);
      const row = db.get('SELECT value FROM app_settings WHERE key = ?', [storeKey]);
      const v = row ? JSON.parse(row.value) : null;
      if (v && typeof v.enabled === 'boolean' && typeof v.schedule === 'string') return { ...v, fromAdmin: true };
    } catch { /* fall back to the configuration */ }
    return null;
  }

  function current() {
    return stored() ?? { enabled: defaults.enabled === true && Boolean(defaults.schedule), schedule: defaults.schedule ?? null, fromAdmin: false };
  }

  function apply() {
    scheduler.unregisterJob(jobName);
    const c = current();
    if (c.enabled && c.schedule) scheduler.registerJob(jobName, c.schedule, handler, registerOptions);
    return get();
  }

  function get() {
    const c = current();
    let nextRun = null;
    if (c.enabled && c.schedule) { try { nextRun = getNextRun(c.schedule, new Date()).toISOString(); } catch { nextRun = null; } }
    return { enabled: c.enabled, schedule: c.schedule, time: timeOfDaily(c.schedule), fromAdmin: c.fromAdmin, nextRun };
  }

  /** `time` ('HH:MM') is required when switching on and the current schedule is not a plain daily one. */
  function set({ enabled, time } = {}) {
    const c = current();
    const schedule = time ? dailyCron(time) : c.schedule;
    if (enabled && !schedule) throw new ScheduleSettingError('TIME_INVALID', 'time must be HH:MM');
    ensureSettingsTable(db);
    db.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [storeKey, JSON.stringify({ enabled: enabled === true, schedule })]);
    return apply();
  }

  return { get, set, apply };
}
