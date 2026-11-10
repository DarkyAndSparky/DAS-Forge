import { describe, it, expect } from 'vitest';
import { renderHomeBody } from '../src/routes.js';

const admin = { username: 'ann', permissions: ['read:basic', 'read:finance', 'admin:write', 'admin.access'] };
const operator = { username: 'bob', permissions: ['read:basic'] };

describe('the start page', () => {
  it('shows the live figures and leaves out a tile with no data', () => {
    const html = renderHomeBody(admin, 'ru', { assets: 12, users: 3, sessions: undefined, version: '0.1.186' });
    expect(html).toContain('Активов');
    expect(html).toContain('>12<');
    expect(html).toContain('0.1.186');
    expect(html).not.toContain('Сессий');
  });

  it('links only to places the person may open', () => {
    const forAdmin = renderHomeBody(admin, 'en');
    expect(forAdmin).toContain('href="/admin/registry"');
    expect(forAdmin).toContain('href="/ui/reporting"');
    const forOperator = renderHomeBody(operator, 'en');
    expect(forOperator).not.toContain('/admin');
    expect(forOperator).not.toContain('/ui/reporting');
    expect(forOperator).toContain('href="/ui/realtime"');
    expect(forOperator).toContain('href="/policy/license"');
  });

  it('escapes the name and speaks one language at a time', () => {
    expect(renderHomeBody({ username: '<b>x</b>', permissions: [] }, 'en')).not.toContain('<b>x</b>');
    expect(renderHomeBody(admin, 'en')).not.toMatch(/[а-яё]/i);
    expect(renderHomeBody(admin, 'ru')).toContain('Что попробовать');
  });
});
