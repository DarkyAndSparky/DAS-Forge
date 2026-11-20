import { ensureSettingsTable, ensureSettingsTableAsync } from '../branding/company-branding.js';
import { asyncDb } from '../database/async.js';
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

  const SELECT = 'SELECT value FROM app_settings WHERE key = ?';
  const UPSERT = 'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';
  /** The stored row as a setting, or null when it is missing or damaged (the configuration applies then). */
  const parseStored = (row) => {
    try {
      const v = row ? JSON.parse(row.value) : null;
      if (v && typeof v.enabled === 'boolean' && typeof v.schedule === 'string') return { ...v, fromAdmin: true };
    } catch { /* fall back to the configuration */ }
    return null;
  };
  const withDefaults = (st) => st ?? { enabled: defaults.enabled === true && Boolean(defaults.schedule), schedule: defaults.schedule ?? null, fromAdmin: false };
  const viewOf = (c) => {
    let nextRun = null;
    if (c.enabled && c.schedule) { try { nextRun = getNextRun(c.schedule, new Date()).toISOString(); } catch { nextRun = null; } }
    return { enabled: c.enabled, schedule: c.schedule, time: timeOfDaily(c.schedule), fromAdmin: c.fromAdmin, nextRun };
  };
  const register = (c) => {
    scheduler.unregisterJob(jobName);
    if (c.enabled && c.schedule) scheduler.registerJob(jobName, c.schedule, handler, registerOptions);
  };
  /** The value `set` would store; throws TIME_INVALID. */
  const nextValue = (c, { enabled, time }) => {
    const schedule = time ? dailyCron(time) : c.schedule;
    if (enabled && !schedule) throw new ScheduleSettingError('TIME_INVALID', 'time must be HH:MM');
    return JSON.stringify({ enabled: enabled === true, schedule });
  };

  function stored() {
    try { ensureSettingsTable(db); return parseStored(db.get(SELECT, [storeKey])); } catch { return null; }
  }

  function current() { return withDefaults(stored()); }

  function apply() {
    register(current());
    return get();
  }

  function get() { return viewOf(current()); }

  /** `time` ('HH:MM') is required when switching on and the current schedule is not a plain daily one. */
  function set(input = {}) {
    const value = nextValue(current(), input);
    ensureSettingsTable(db);
    db.run(UPSERT, [storeKey, value]);
    return apply();
  }

  // The same operations over `asyncDb`.
  const a = asyncDb(db);
  async function currentAsync() {
    try { await ensureSettingsTableAsync(a); return withDefaults(parseStored(await a.get(SELECT, [storeKey]))); } catch { return withDefaults(null); }
  }
  async function getAsync() { return viewOf(await currentAsync()); }
  async function applyAsync() {
    register(await currentAsync());
    return getAsync();
  }
  async function setAsync(input = {}) {
    const value = nextValue(await currentAsync(), input);
    await ensureSettingsTableAsync(a);
    await a.run(UPSERT, [storeKey, value]);
    return applyAsync();
  }

  return { get, set, apply, getAsync, setAsync, applyAsync };
}
