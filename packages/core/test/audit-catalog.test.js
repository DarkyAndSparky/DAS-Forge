import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeEvent, registerEvents, listEvents, EVENT_CATEGORIES } from '../src/audit/index.js';

function files(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) files(p, out); else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

describe('audit event catalogue (stage B)', () => {
  it('describes a known action in both languages, with a sentence', () => {
    const e = { action: 'admin.user.force_logout', actor: 'ivan', entity: 'user', entityId: 42, meta: { revokedSessions: 3 } };
    expect(describeEvent(e, 'ru')).toMatchObject({ known: true, title: 'Завершены все сессии', category: 'users', severity: 'notice' });
    expect(describeEvent(e, 'ru').phrase).toBe('ivan завершил все сессии пользователя user#42; завершено: 3');
    expect(describeEvent(e, 'en').phrase).toBe('ivan ended all sessions of user#42; ended: 3');
  });
  it('shows an unknown action by its code and never throws', () => {
    expect(describeEvent({ action: 'shop.order.ship' }, 'ru')).toMatchObject({ known: false, title: 'shop.order.ship', phrase: null });
    expect(describeEvent(null)).toMatchObject({ known: false });
  });
  it('applications can add their own actions; bad codes are refused', () => {
    registerEvents({ 'shop.order.ship': { ru: 'Заказ отправлен', en: 'Order shipped', category: 'data', phrase: { ru: '{actor} отправил {target}', en: '{actor} shipped {target}' } } });
    expect(describeEvent({ action: 'shop.order.ship', actor: 'a', entity: 'order', entityId: 7 }, 'en').phrase).toBe('a shipped order#7');
    expect(() => registerEvents({ 'Bad Code': { ru: 'x', en: 'x', category: 'data' } })).toThrow();
  });
  it('every category used exists and every entry has both languages', () => {
    for (const e of listEvents()) {
      expect(EVENT_CATEGORIES[e.category] || e.category).toBeTruthy();
      expect(e.ru && e.en).toBeTruthy();
    }
  });
  it('every action code written in the core sources is in the catalogue', () => {
    const known = new Set(listEvents().map((e) => e.code));
    const seen = new Set();
    for (const f of files(fileURLToPath(new URL('../src', import.meta.url)))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(?:action: |audit\(req, |audited\(req, )'([a-z_]+(?:\.[a-z_]+)+)'/g)) seen.add(m[1]);
    }
    const missing = [...seen].filter((c) => !known.has(c));
    expect(missing).toEqual([]);
  });
});
