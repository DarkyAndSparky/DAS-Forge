import { describe, it, expect } from 'vitest';
import { searchSections, configKeyMatches } from '../src/admin/search.js';
import { createSqliteAdapter } from '../src/database/index.js';
import { log, query } from '../src/audit/index.js';

const index = [
  { key: 'audit', label: 'Аудит', labels: { ru: 'Аудит', en: 'Audit' }, group: 'Безопасность', path: '/admin/audit' },
  { key: 'users', label: 'Пользователи', labels: { ru: 'Пользователи', en: 'Users' }, group: '', path: '/admin/users' },
];

describe('admin search: both languages, settings, stems', () => {
  it('finds a section by its English name while the interface is Russian, and the other way round', () => {
    expect(searchSections(index, 'audit', 'ru').map((e) => e.path)).toEqual(['/admin/audit']);
    expect(searchSections(index, 'аудит', 'en').map((e) => e.path)).toEqual(['/admin/audit']);
  });
  it('finds the page "Не входили давно" by "не входил давно" (stem) inside Users', () => {
    expect(searchSections(index, 'не входил давно', 'ru').map((e) => e.path)).toEqual(['/admin/users']);
    expect(searchSections(index, 'lockouts', 'ru').map((e) => e.path)).toEqual(['/admin/users']);
  });
  it('finds settings by their Russian or English words', () => {
    expect(configKeyMatches('server.port', 'порт')).toBe(true);
    expect(configKeyMatches('server.port', 'port')).toBe(true);
    expect(configKeyMatches('security.rateLimit.max', 'лимит запросов')).toBe(true);
    expect(configKeyMatches('server.port', 'почта')).toBe(false);
  });
  it('audit action filter is a substring search', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    log(db, { action: 'task.run', entity: 'task' });
    log(db, { action: 'admin.task.disable', entity: 'task' });
    log(db, { action: 'auth.login', entity: 'user' });
    expect(query(db, { actionContains: 'task' })).toHaveLength(2);
    expect(query(db, { actionContains: 'ta%k' })).toHaveLength(0); // % is not a wildcard
  });
});
