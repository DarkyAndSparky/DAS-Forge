import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createScheduler, createScheduleSetting, dailyCron, timeOfDaily } from '../src/scheduler/index.js';

function setup(defaults = { enabled: true, schedule: '5 3 * * *' }) {
  const db = createSqliteAdapter({ file: ':memory:' });
  const scheduler = createScheduler({});
  const setting = createScheduleSetting({ db, scheduler, key: 'doctor', jobName: 'alerts-doctor', handler: () => {}, defaults });
  return { db, scheduler, setting };
}

describe('daily cron helpers', () => {
  it('converts HH:MM both ways and refuses anything else', () => {
    expect(dailyCron('03:05')).toBe('5 3 * * *');
    expect(dailyCron('23:59')).toBe('59 23 * * *');
    expect(timeOfDaily('5 3 * * *')).toBe('03:05');
    expect(timeOfDaily('5 * * * *')).toBe(null);
    for (const bad of ['24:00', '7', '12:60', '', 'ab:cd']) expect(() => dailyCron(bad)).toThrow();
  });
});

describe('createScheduleSetting', () => {
  it('uses the configuration until the administrator changes it', () => {
    const { setting, scheduler } = setup();
    expect(setting.get()).toMatchObject({ enabled: true, schedule: '5 3 * * *', time: '03:05', fromAdmin: false });
    setting.apply();
    expect(scheduler.getJobStatus('alerts-doctor').expression).toBe('5 3 * * *');
  });

  it('moves the job to another time, switches it off and on, and remembers the choice in the database', () => {
    const { db, setting, scheduler } = setup();
    setting.apply();
    setting.set({ enabled: true, time: '07:30' });
    expect(scheduler.getJobStatus('alerts-doctor').expression).toBe('30 7 * * *');
    setting.set({ enabled: false });
    expect(scheduler.getJobStatus('alerts-doctor')).toBe(null);
    expect(setting.get()).toMatchObject({ enabled: false, fromAdmin: true, nextRun: null });
    // a new process: the stored choice wins over the configuration
    const second = createScheduler({});
    const again = createScheduleSetting({ db, scheduler: second, key: 'doctor', jobName: 'alerts-doctor', handler: () => {}, defaults: { enabled: true, schedule: '5 3 * * *' } });
    again.apply();
    expect(second.getJobStatus('alerts-doctor')).toBe(null);
    again.set({ enabled: true });
    expect(second.getJobStatus('alerts-doctor').expression).toBe('30 7 * * *'); // switching on keeps the last time
  });

  it('configured off stays off until switched on with a time; a non-daily configured cron is kept', () => {
    const off = setup({ enabled: false, schedule: null });
    off.setting.apply();
    expect(off.scheduler.getJobStatus('alerts-doctor')).toBe(null);
    let err;
    try { off.setting.set({ enabled: true }); } catch (e) { err = e; }
    expect(err?.code).toBe('TIME_INVALID');
    off.setting.set({ enabled: true, time: '04:00' });
    expect(off.scheduler.getJobStatus('alerts-doctor').expression).toBe('0 4 * * *');
    const hourly = setup({ enabled: true, schedule: '5 * * * *' });
    expect(hourly.setting.get().time).toBe(null);
    hourly.setting.set({ enabled: true });
    expect(hourly.setting.get().schedule).toBe('5 * * * *');
  });

  it('gives a next run time while on', () => {
    expect(Number.isNaN(Date.parse(setup().setting.get().nextRun))).toBe(false);
  });
});
