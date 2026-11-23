import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createIncidentRegister, ensureIncidentTableAsync, IncidentError, INCIDENT_REGIMES } from '../src/privacy/incidents.js';

const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-11-01T00:00:00Z');
const setup = (opts = {}) => { const db = createSqliteAdapter({ file: ':memory:' }); return { db, reg: createIncidentRegister(db, { now: () => T0 + HOUR, ...opts }) }; };
const at = (h) => new Date(T0 + h * HOUR).toISOString();

describe('incident notice regimes', () => {
  it('counts the milestones of one regime from detection', () => {
    const { reg } = setup();
    const i = reg.declare({ title: 'x', regimes: ['nis2'], detectedAt: at(0) });
    expect(i.regimes).toEqual(['nis2']);
    expect(i.firstNoticeDue.at).toBe(at(24));
    expect(i.detailsDue.at).toBe(at(72));
    expect(i.finalNoticeDue.at).toBe(at(720));
    expect(reg.declare({ title: 'y', regimes: ['kii-significant'], detectedAt: at(0) }).detailsDue).toBeNull();
  });
  it('takes the earliest time when several regimes apply, and keeps personal data as a regime of its own', () => {
    const { reg } = setup();
    const i = reg.declare({ title: 'x', personalData: true, regimes: ['kii-significant', 'nis2'], detectedAt: at(0) });
    expect(i.regimes).toEqual(['pd', 'kii-significant', 'nis2']);
    expect(i.firstNoticeDue.at).toBe(at(3)); // the 3 h rule is the earliest
    expect(i.detailsDue.at).toBe(at(72));
    expect(i.finalNoticeDue.at).toBe(at(720));
  });
  it('marks a milestone overdue until it is recorded, and lists the incident in overdue()', () => {
    let now = T0 + 4 * HOUR;
    const { reg } = setup({ now: () => now });
    const i = reg.declare({ title: 'x', regimes: ['kii-significant'], detectedAt: at(0) });
    expect(i.firstNoticeDue.overdue).toBe(true);
    expect(reg.overdue().map((r) => r.id)).toEqual([i.id]);
    const sent = reg.update(i.id, { firstNoticeAt: at(2) });
    expect(sent.firstNoticeDue).toMatchObject({ done: true, overdue: false });
    now = T0 + 800 * HOUR;
    const n = reg.declare({ title: 'z', regimes: ['nis2'], detectedAt: at(0) });
    reg.update(n.id, { firstNoticeAt: at(1), detailsNoticeAt: at(2) });
    expect(reg.get(n.id).finalNoticeDue.overdue).toBe(true);
    expect(reg.update(n.id, { finalNoticeAt: at(100) }).finalNoticeDue.overdue).toBe(false);
  });
  it('changes regimes on update, refuses unknown ones, and takes hours from the options', () => {
    const { reg } = setup({ regimes: { nis2: { first: 12 } } });
    const i = reg.declare({ title: 'x', detectedAt: at(0) });
    expect(i.regimes).toEqual([]);
    const u = reg.update(i.id, { regimes: ['nis2'] });
    expect(u.firstNoticeDue.at).toBe(at(12));
    expect(() => reg.update(i.id, { regimes: ['nope'] })).toThrow(IncidentError);
    expect(() => reg.declare({ title: 'x', regimes: ['__proto__'] })).toThrow(/REGIME_INVALID/);
    expect(Object.keys(INCIDENT_REGIMES)).toEqual(['pd', 'kii-significant', 'kii', 'nis2', 'cra']);
  });
  it('adds the new columns to a table made by an older version', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    db.exec(`CREATE TABLE security_incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', severity TEXT NOT NULL DEFAULT 'medium', personal_data INTEGER NOT NULL DEFAULT 0, detected_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', first_notice_at TEXT, details_notice_at TEXT, measures TEXT NOT NULL DEFAULT '', closed_at TEXT, created_by TEXT, created_at TEXT NOT NULL)`);
    db.run("INSERT INTO security_incidents (title, personal_data, detected_at, created_at) VALUES ('old', 1, ?, ?)", [at(0), at(0)]);
    const reg = createIncidentRegister(db, { now: () => T0 + HOUR });
    const old = reg.get(1);
    expect(old.regimes).toEqual(['pd']); // a row from before regimes: personal data means the pd regime
    expect(old.firstNoticeDue.at).toBe(at(24));
    expect(reg.update(1, { finalNoticeAt: at(5) }).finalNoticeAt).toBe(at(5));
    await ensureIncidentTableAsync(db); // twice is fine
  });
});
