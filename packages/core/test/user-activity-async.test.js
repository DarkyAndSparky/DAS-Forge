import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { ensureAuditTable, log } from '../src/audit/index.js';
import { createManagedUser } from '../src/auth/user-admin.js';
import { ensureDeviceTable, recognizeDevice } from '../src/auth/devices.js';
import { lastActivityByUser, lastActivityByUserAsync, inactiveUsers, inactiveUsersAsync, userCard, userCardAsync } from '../src/admin/user-activity.js';

function seed({ withAudit = true } = {}) {
  const db = createSqliteAdapter({ file: ':memory:', walMode: false });
  ensureAuthTables(db);
  if (withAudit) ensureAuditTable(db);
  ensureDeviceTable(db);
  const mk = (name) => createManagedUser(db, { username: name, email: `${name}@x.io`, role: 'operator', passwordHash: 'h', mustChangePassword: false });
  const a = mk('active-ann');
  const o = mk('old-olga');
  const d = mk('dead-dan');
  db.run('UPDATE users SET created_at = ? WHERE id IN (?, ?)', ['2020-01-01T00:00:00.000Z', o.id, d.id]);
  if (withAudit) {
    log(db, { actor: 'active-ann', action: 'auth.login', entity: 'user', entityId: a.id });
    log(db, { actor: 'x', action: 'auth.password_reset', entity: 'user', entityId: a.id });
  }
  recognizeDevice(db, { userId: a.id, deviceId: null, ip: '1.1.1.1', userAgent: 'UA' });
  db.run('UPDATE users SET disabled = 1 WHERE id = ?', [d.id]);
  return { db, a, o, d };
}

describe('user activity over the asynchronous database', () => {
  it('last activity, inactive accounts and the card match the synchronous versions', async () => {
    const { db, a, o } = seed();
    expect([...(await lastActivityByUserAsync(db))]).toEqual([...lastActivityByUser(db)]);
    const idle = await inactiveUsersAsync(db, { days: 30 });
    expect(idle).toEqual(inactiveUsers(db, { days: 30 }));
    expect(idle.map((u) => u.username)).toEqual(['old-olga']);
    const card = await userCardAsync(db, a.id);
    expect(card).toEqual(userCard(db, a.id));
    expect(card.recent.length).toBeGreaterThan(0);
    expect(card.passwordChangedAt).not.toBeNull();
    expect((await userCardAsync(db, o.id)).lastLoginAt).toBeNull();
    expect(await userCardAsync(db, 999)).toBeNull();
  });
  it('works without the audit table (it is optional)', async () => {
    const { db, a } = seed({ withAudit: false });
    const card = await userCardAsync(db, a.id);
    expect(card.recent).toEqual([]);
    expect(card.passwordChangedAt).toBeNull();
    expect(card).toEqual(userCard(db, a.id));
  });
});
