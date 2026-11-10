import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { diffChanges, log, query } from '../src/audit/index.js';

describe('audit changes (stage D)', () => {
  it('lists only what changed, and masks secrets by field name', () => {
    const c = diffChanges({ role: 'user', email: 'a@x', passwordHash: 'old', n: 1 }, { role: 'admin', email: 'a@x', passwordHash: 'new', n: 1 });
    expect(c).toEqual({ role: { from: 'user', to: 'admin' }, passwordHash: { from: '••••', to: '••••' } });
  });
  it('honours `fields`, extra secret names, clips long values and handles missing sides', () => {
    expect(diffChanges({ a: 1, b: 2 }, { a: 2, b: 3 }, { fields: ['a'] })).toEqual({ a: { from: 1, to: 2 } });
    expect(diffChanges({ pin: '1' }, { pin: '2' }, { secret: ['pin'] })).toEqual({ pin: { from: '••••', to: '••••' } });
    expect(diffChanges({}, { note: 'x'.repeat(500) }).note.to.length).toBe(201);
    expect(diffChanges(null, undefined)).toEqual({});
  });
  it('the log accepts the result "denied" and refuses anything else', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    log(db, { action: 'admin.user.delete', result: 'denied', meta: { changes: diffChanges({ a: 1 }, { a: 2 }) } });
    expect(query(db, { result: 'denied' })).toHaveLength(1);
    expect(() => log(db, { action: 'x.y', result: 'maybe' })).toThrow();
  });
});
