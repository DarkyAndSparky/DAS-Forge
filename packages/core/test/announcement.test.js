import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createAnnouncement, AnnouncementError } from '../src/announcement/index.js';
import { createAdmin } from '../src/admin/index.js';
import { renderAppShell } from '../src/ui/shell.js';
import { query } from '../src/audit/index.js';

function setup() {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  let t = Date.parse('2026-10-29T10:00:00Z');
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  return { db, clock, a: createAnnouncement({ db, cacheMs: 0, now: clock.now }) };
}

describe('announcement', () => {
  it('is empty by default and renders nothing', () => {
    const { a } = setup();
    expect(a.active()).toBe(null);
    expect(a.bannerHtml('ru')).toBe('');
  });

  it('validates input', () => {
    const { a } = setup();
    for (const [input, code] of [[{ message: '  ' }, 'MESSAGE_REQUIRED'], [{ message: 'x'.repeat(301) }, 'MESSAGE_TOO_LONG'], [{ message: 'a', level: 'loud' }, 'LEVEL_INVALID'], [{ message: 'a', until: 'nope' }, 'UNTIL_INVALID']]) {
      let err;
      try { a.set(input); } catch (e) { err = e; }
      expect(err instanceof AnnouncementError).toBe(true);
      expect(err.code).toBe(code);
    }
  });

  it('shows the escaped text, a dismiss button for info and none for critical, and disappears at the end time', () => {
    const { a, clock } = setup();
    a.set({ message: '<b>Work at 22:00</b>', level: 'info', until: '2026-10-29T12:00:00Z', by: 'root' });
    const html = a.bannerHtml('en', { nonce: 'n1' });
    expect(html).toContain('&lt;b&gt;Work at 22:00&lt;/b&gt;');
    expect(html).not.toContain('<b>Work');
    expect(html).toContain('<button');
    expect(html).toContain('nonce="n1"');
    expect(html).toContain('until');
    a.set({ message: 'Down', level: 'critical' });
    expect(a.bannerHtml('ru')).not.toContain('<button');
    a.set({ message: 'Soon', until: '2026-10-29T12:00:00Z' });
    clock.advance(2 * 3600_000 + 1);
    expect(a.active()).toBe(null);
    expect(a.bannerHtml('ru')).toBe('');
  });

  it('a new text gets a new id (so a dismissed banner comes back), clear() switches it off', () => {
    const { a, clock } = setup();
    const first = a.set({ message: 'one' }).id;
    clock.advance(1000);
    expect(a.set({ message: 'two' }).id).not.toBe(first);
    a.clear();
    expect(a.active()).toBe(null);
  });

  it('the shell puts the banner above the header', () => {
    const { a } = setup();
    a.set({ message: 'Hello' });
    const html = renderAppShell({ moduleRegistry: {}, bodyHtml: 'X', bannerHtml: a.bannerHtml('en') });
    const at = html.indexOf('class="adm-ann ');
    expect(at > -1 && at < html.indexOf('<header')).toBe(true);
  });
});

describe('announcement section', () => {
  it('publishes, rejects bad input, clears, audits and shows the banner on admin pages', async () => {
    const { db, a } = setup();
    const routes = {};
    const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
    createAdmin({ db, announcement: a, users: false }).mount(app, { requireAuth: () => (q, r, n) => n(), requirePermission: () => (q, r, n) => n() });
    const call = (key, req) => new Promise((resolve) => {
      const res = { locals: {}, set() { return this; }, type() { return this; }, send(b) { res.body = b; resolve(res); }, redirect(c, loc) { res.location = loc; resolve(res); } };
      let i = 0;
      const chain = routes[key];
      const next = () => { const h = chain[i++]; if (h) Promise.resolve(h({ user: { username: 'root', permissions: [] }, query: {}, params: {}, headers: {}, on(ev, cb) { if (ev === 'end') cb(); return this; }, ...req }, res, next)).catch((e) => { res.body = String(e); resolve(res); }); };
      next();
    });
    let r = await call('GET /admin/announcement', {});
    expect(r.body).toContain('/admin/announcement/set');
    // G-03: two administrators opened the same form; the second save is refused instead of silently undoing the first
    const v = /name="_v" value="([0-9a-f]+)"/.exec(r.body)[1];
    r = await call('POST /admin/announcement/set', { body: { message: 'First', level: 'info', _v: v } });
    expect(r.location).toBe('/admin/announcement?msg=ok');
    r = await call('POST /admin/announcement/set', { body: { message: 'Second', level: 'info', _v: v } });
    expect(r.location).toBe('/admin/announcement?msg=bad&e=CONFLICT');
    expect(a.get({ fresh: true }).message).toBe('First');
    r = await call('POST /admin/announcement/set', { body: { message: 'Planned work', level: 'warning', until: '2026-10-29T23:00' } });
    expect(r.location).toBe('/admin/announcement?msg=ok');
    expect(a.get({ fresh: true })).toMatchObject({ enabled: true, message: 'Planned work', level: 'warning', updatedBy: 'root' });
    r = await call('POST /admin/announcement/set', { body: { message: '' } });
    expect(r.location).toBe('/admin/announcement?msg=bad&e=MESSAGE_REQUIRED');
    expect((await call('GET /admin', {})).body).toContain('Planned work');
    await call('POST /admin/announcement/clear', { body: { a: 1 } });
    expect(a.get({ fresh: true }).enabled).toBe(false);
    expect(query(db, { action: 'admin.announcement.set' })).toHaveLength(2); // 'First' (G-03 check) and 'Planned work'
    expect(query(db, { action: 'admin.announcement.clear' })).toHaveLength(1);
  });
});
