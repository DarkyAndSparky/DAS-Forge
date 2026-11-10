import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createAdmin, svgBarChart } from '../src/admin/index.js';
import { timeHtml, parseUtc, formatUtc, TIME_SCRIPT } from '../src/ui/time.js';
import { renderAppShell } from '../src/ui/shell.js';

describe('dates in pages', () => {
  it('reads ISO and SQLite UTC dates; anything else is not a date', () => {
    expect(parseUtc('2026-10-27T15:57:40.000Z').toISOString()).toBe('2026-10-27T15:57:40.000Z');
    expect(parseUtc('2026-10-27 15:57:40').toISOString()).toBe('2026-10-27T15:57:40.000Z');
    expect(parseUtc('')).toBe(null);
    expect(parseUtc('вчера')).toBe(null);
  });

  it('writes a <time> with the UTC fallback in the language order', () => {
    const d = parseUtc('2026-10-27 15:57:40');
    expect(formatUtc(d, 'ru')).toBe('27.10.2026 15:57:40 UTC');
    expect(formatUtc(d, 'en')).toBe('2026-10-27 15:57:40 UTC');
    const html = timeHtml('2026-10-27 15:57:40', 'ru');
    expect(html).toContain('<time class="adm-time" datetime="2026-10-27T15:57:40.000Z">27.10.2026 15:57:40 UTC</time>');
  });

  it('empty value gives the placeholder and an unreadable one is escaped', () => {
    expect(timeHtml(null, 'ru', '—')).toBe('—');
    expect(timeHtml('<b>x</b>', 'ru')).toBe('&lt;b&gt;x&lt;/b&gt;');
  });

  it('the shell carries the script that converts them in the browser', () => {
    const html = renderAppShell({ moduleRegistry: { navigation: [] }, viewerPermissions: [], locale: 'ru', activePath: '/', title: 'T', bodyHtml: '' });
    expect(html).toContain(TIME_SCRIPT);
    expect(TIME_SCRIPT).toContain('time.adm-time');
  });
});

describe('tables and charts', () => {
  it('whole-number data gets whole-number ticks', () => {
    const svg = svgBarChart([{ label: 'a', value: 1 }, { label: 'b', value: 0 }]);
    expect(svg).not.toMatch(/>0\.\d</);
    expect(svg).not.toMatch(/>\d+\.\d</);
  });

  it('an empty audit table says so, and wide tables are wrapped to scroll', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    ensureAuthTables(db);
    const routes = {};
    const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: () => {} };
    createAdmin({ db }).mount(app, { requireAuth: () => (req, res, next) => next(), requirePermission: () => (req, res, next) => next() });
    const res = await new Promise((resolve) => {
      const r = { locals: {}, set() { return this; }, type() { return this; }, send(b) { resolve(b); } };
      let i = 0; const chain = routes['GET /admin/audit']; const next = () => { const h = chain[i++]; if (h) h({ user: { permissions: ['admin.access'] }, query: {}, headers: {} }, r, next); };
      next();
    });
    expect(res).toContain('class="adm-empty"');
    expect(res).toContain('<div class="adm-scroll"><table class="adm-table"');
    expect(res).toContain('Записей нет');
  });
});
