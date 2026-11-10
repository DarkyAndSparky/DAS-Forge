import { describe, it, expect } from 'vitest';
import { coreNamespaces } from '../src/i18n/catalog.js';

const isObj = (v) => v !== null && typeof v === 'object';
function flat(o, p = '', out = {}) {
  for (const [k, v] of Object.entries(o ?? {})) {
    const key = p ? `${p}.${k}` : k;
    if (isObj(v)) flat(v, key, out);
    else out[key] = v;
  }
  return out;
}

describe('core texts are complete in every language', () => {
  const ns = coreNamespaces();

  it('lists the expected namespaces', () => {
    expect(Object.keys(ns).sort()).toEqual(
      ['accounts', 'admin-alerts', 'admin-appearance', 'admin-audit', 'admin-broadcast', 'admin-incidents', 'admin-ops', 'admin-overview', 'admin-password', 'admin-registry', 'admin-system', 'email', 'errors', 'policy-defaults', 'policy-ui', 'ui'],
    );
  });

  for (const [name, bundles] of Object.entries(coreNamespaces())) {
    it(`${name}: ru and en have the same keys and no empty text`, () => {
      const ru = flat(bundles.ru);
      const en = flat(bundles.en);
      expect(Object.keys(ru).length).toBeGreaterThan(0);
      expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
      for (const [k, v] of Object.entries({ ...ru, ...en })) {
        if (typeof v === 'string') expect(v.trim(), `${name}.${k}`).not.toBe('');
      }
    });
  }
});

import { setTextOverrides } from '../src/i18n/overrides.js';
import { errorText } from '../src/http/error-catalog.js';
import { renderEmail } from '../src/email/templates.js';

describe('process-wide overrides of core texts', () => {
  it('replace single fields of error texts, per language, and can be cleared', () => {
    const before = errorText(404, 'ru');
    setTextOverrides({ errors: { ru: { 404: { title: 'Нет такой страницы' } } } });
    try {
      const t = errorText(404, 'ru');
      expect(t.title).toBe('Нет такой страницы');
      expect(t.message).toBe(before.message);
      expect(errorText(404, 'en').title).not.toBe('Нет такой страницы');
    } finally {
      setTextOverrides({});
    }
    expect(errorText(404, 'ru').title).toBe(before.title);
  });

  it('replace an e-mail scenario', () => {
    setTextOverrides({ email: { en: { alert: (d) => ({ subject: `X ${d.title}`, lead: 'l', body: 'b' }) } } });
    try {
      const mail = renderEmail('alert', { severity: 'info', title: 'T', message: 'm' }, { locale: 'en' });
      expect(mail.subject).toBe('X T');
    } finally {
      setTextOverrides({});
    }
  });
});
