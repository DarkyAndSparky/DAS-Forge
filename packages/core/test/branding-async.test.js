import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import {
  getCompanyBranding, setCompanyBranding, getEffectiveBranding,
  getCompanyBrandingAsync, setCompanyBrandingAsync, getEffectiveBrandingAsync,
  brandingHtml, brandingHtmlAsync, themeWithBranding, themeWithBrandingAsync,
} from '../src/branding/index.js';

describe('branding async twins', () => {
  it('give the same results as the sync functions', async () => {
    const a = createSqliteAdapter({ file: ':memory:', walMode: false });
    const b = createSqliteAdapter({ file: ':memory:', walMode: false });
    expect(await getCompanyBrandingAsync(a)).toEqual(getCompanyBranding(b));
    const patch = { companyName: 'Acme', accent: '#aa3300' };
    const x = await setCompanyBrandingAsync(a, patch, { actor: 'u1' });
    const y = setCompanyBranding(b, patch, { actor: 'u1' });
    expect(x.companyName).toBe(y.companyName);
    expect(x.updatedBy).toBe('u1');
    expect((await getCompanyBrandingAsync(a)).accent).toBe('#aa3300');
    const id = { name: 'Vendor', getLogo: () => ({ format: 'none' }) };
    expect((await getEffectiveBrandingAsync(a, id)).companyName).toBe(getEffectiveBranding(b, id).companyName);
    expect(await brandingHtmlAsync(a, { fallbackName: 'F' })).toBe(brandingHtml(b, { fallbackName: 'F' }));
    expect(await themeWithBrandingAsync(a, {})).toEqual(themeWithBranding(b, {}));
  });
  it('rejects invalid patches', async () => {
    const a = createSqliteAdapter({ file: ':memory:', walMode: false });
    let err;
    try { await setCompanyBrandingAsync(a, { accent: 'not-a-colour' }); } catch (e) { err = e; }
    expect(err).toBeDefined();
  });
});
