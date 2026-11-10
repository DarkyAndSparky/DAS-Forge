import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createNotifications } from '../src/notifications/index.js';
import { bellHtml, notificationsBodyHtml, prefsFormHtml } from '../src/notifications/page.js';
import { createAlerts } from '../src/alerts/index.js';

function setup() {
  const db = createSqliteAdapter({ file: ':memory:' });
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT, disabled INTEGER DEFAULT 0)');
  db.run("INSERT INTO users (id, role) VALUES (1,'admin'),(2,'admin'),(3,'operator')");
  db.run("INSERT INTO users (id, role, disabled) VALUES (4,'admin',1)");
  return { db, n: createNotifications({ db }) };
}

describe('notifications', () => {
  it('writes, counts and lists for one user', () => {
    const { n } = setup();
    expect(n.notify({ userId: 1, title: 'Hello', severity: 'critical' })).toBeTruthy();
    expect(n.unreadCount(1)).toBe(1);
    expect(n.unreadCount(2)).toBe(0);
    expect(n.list(1)[0].title).toBe('Hello');
  });
  it('refuses an empty title and keeps only same-site links', () => {
    const { n } = setup();
    expect(n.notify({ userId: 1, title: '  ' })).toBe(null);
    n.notify({ userId: 1, title: 'a', link: '//evil.example' });
    n.notify({ userId: 1, title: 'b', link: 'javascript:alert(1)' });
    n.notify({ userId: 1, title: 'c', link: '/admin/alerts' });
    const links = n.list(1).map((i) => i.link);
    expect(links.filter(Boolean)).toEqual(['/admin/alerts']);
    expect(links.length).toBe(3);
  });
  it('only the owner can mark a notification as read', () => {
    const { n } = setup();
    const id = n.notify({ userId: 1, title: 'x' });
    expect(n.markRead(2, id)).toBe(0);
    expect(n.unreadCount(1)).toBe(1);
    expect(n.markRead(1, id)).toBe(1);
    expect(n.unreadCount(1)).toBe(0);
  });
  it('notifyRole reaches enabled users of the role only', () => {
    const { n } = setup();
    expect(n.notifyRole('admin', { title: 'x' })).toBe(2);
    expect(n.unreadCount(3)).toBe(0);
    expect(n.unreadCount(4)).toBe(0);
  });
  it('a user can switch a category off or raise its minimum severity', () => {
    const { n } = setup();
    expect(n.setPref(1, 'security', 'critical')).toBe(true);
    expect(n.setPref(1, 'system', 'off')).toBe(true);
    expect(n.setPref(1, 'system', 'loud')).toBe(false);
    expect(n.notify({ userId: 1, title: 'w', severity: 'warning', category: 'security' })).toBe(null);
    expect(n.notify({ userId: 1, title: 'c', severity: 'critical', category: 'security' })).toBeTruthy();
    expect(n.notify({ userId: 1, title: 's', severity: 'critical', category: 'system' })).toBe(null);
    expect(n.notify({ userId: 1, title: 'o', category: 'other' })).toBeTruthy();
    expect(n.notify({ userId: 2, title: 'w', severity: 'warning', category: 'security' })).toBeTruthy();
  });
  it('purge drops old READ notifications and keeps unread', () => {
    const { db } = setup();
    let t = Date.parse('2026-01-01');
    const n = createNotifications({ db, keepDays: 10, now: () => t });
    const a = n.notify({ userId: 1, title: 'old read' });
    n.notify({ userId: 1, title: 'old unread' });
    n.markRead(1, a);
    t += 11 * 86_400_000;
    expect(n.purge()).toBe(1);
    expect(n.list(1).map((i) => i.title)).toEqual(['old unread']);
  });
  it('the read cap removes only read ones', () => {
    const { db } = setup();
    const n = createNotifications({ db, maxPerUser: 2 });
    for (let i = 0; i < 4; i += 1) n.markRead(1, n.notify({ userId: 1, title: `r${i}` }));
    n.notify({ userId: 1, title: 'unread' });
    expect(n.list(1, { limit: 50 }).length).toBeLessThanOrEqual(3);
    expect(n.unreadCount(1)).toBe(1);
  });
});

describe('bell and page markup', () => {
  it('shows the count and caps it', () => {
    expect(bellHtml({ url: '/ui/notifications', count: 3 })).toContain('>3<');
    expect(bellHtml({ url: '/x', count: 500 })).toContain('99+');
    expect(bellHtml({ url: '/x', count: 0 })).not.toContain('adm-bell-count');
  });
  it('escapes titles, bodies and links', () => {
    const html = notificationsBodyHtml({ basePath: '/n', items: [{ id: 1, severity: 'info', title: '<img src=x onerror=1>', body: '<b>', link: '/a"b', createdAt: '2026-01-01T10:00:00Z', readAt: null }] });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img');
  });
  it('the settings form lists the categories with the current choice', () => {
    const html = prefsFormHtml({ basePath: '/n', categories: [{ key: 'security', label: { ru: 'Безопасность', en: 'Security' } }], prefs: { security: 'critical' } });
    expect(html).toContain('name="c_security"');
    expect(html).toContain('value="critical" selected');
    expect(prefsFormHtml({ basePath: '/n', categories: [], prefs: {} })).toBe('');
  });
});

describe('alerts -> onRaised', () => {
  it('is called for a new alert, not for a repeat, and a broken listener changes nothing', async () => {
    const { db } = setup();
    const seen = [];
    const alerts = createAlerts({ db, onRaised: (a) => { seen.push(a.key); throw new Error('boom'); } });
    expect((await alerts.raise({ key: 'k', title: 'T' })).raised).toBe(true);
    expect((await alerts.raise({ key: 'k', title: 'T' })).raised).toBe(false);
    expect(seen).toEqual(['k']);
  });
});
