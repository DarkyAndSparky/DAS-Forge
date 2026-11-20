import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createNotifications, ensureNotificationsTableAsync } from '../src/notifications/index.js';

const fresh = () => createSqliteAdapter({ file: ':memory:', walMode: false });

describe('notifications over the asynchronous database', () => {
  it('notifies, respects preferences, marks only for the owner, shares rows with the sync methods', async () => {
    const db = fresh();
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT, disabled INTEGER DEFAULT 0)');
    db.run('INSERT INTO users (id, role) VALUES (1, ?), (2, ?), (3, ?)', ['admin', 'admin', 'user']);
    await ensureNotificationsTableAsync(db);
    const n = createNotifications({ db });
    const id = await n.notifyAsync({ userId: 1, title: 'Hello', link: '//evil.com', severity: 'warning' });
    expect(id).toBeGreaterThan(0);
    expect(n.list(1)[0].link).toBe(null);
    expect(await n.notifyAsync({ userId: 1, title: '' })).toBeNull();
    expect(await n.setPrefAsync(1, 'general', 'critical')).toBe(true);
    expect(await n.notifyAsync({ userId: 1, title: 'minor' })).toBeNull();
    expect(await n.notifyRoleAsync('admin', { title: 'to admins', severity: 'critical' })).toBe(2);
    expect(await n.unreadCountAsync(2)).toBe(1);
    expect(await n.markReadAsync(3, id)).toBe(0);
    expect(await n.markReadAsync(1, id)).toBe(1);
    expect(n.unreadCount(1)).toBe(1);
    expect((await n.listAsync(1, { unreadOnly: true })).length).toBe(1);
    expect(await n.markAllReadAsync(1)).toBe(1);
    expect(await n.purgeAsync()).toBe(0);
  });
  it('keeps at most maxPerUser read notifications', async () => {
    const db = fresh();
    await ensureNotificationsTableAsync(db);
    const n = createNotifications({ db, maxPerUser: 2 });
    for (let i = 0; i < 4; i += 1) { const id = await n.notifyAsync({ userId: 1, title: `t${i}` }); await n.markReadAsync(1, id); }
    expect((await n.listAsync(1)).length).toBeLessThan(4);
  });
});
