import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';

import { createSqliteAdapter } from '../src/database/index.js';
import {
  resolveVendorLogo,
  defineVendorIdentity,
  CORE_IDENTITY,
  getCompanyBranding,
  setCompanyBranding,
  getEffectiveBranding,
} from '../src/branding/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('CORE_IDENTITY', () => {
  it('is fixed and resolves the real beta PNG logo shipped in this repo', () => {
    expect(CORE_IDENTITY.name).toBe('DAS-Forge');
    expect(CORE_IDENTITY.repoUrl).toContain('github.com');
    const logo = CORE_IDENTITY.logo;
    expect(logo).not.toBeNull();
    // 'png' - the real beta artwork (assets/brand/logo.png,
    // logo-dark.png) replaced the placeholder logo.svg/logo-dark.svg
    // monogram in 0.1.10 (see assets/brand/README.md). Vector versions
    // of this same mark are expected later and will take priority again
    // automatically once dropped in, no code change needed.
    expect(logo.format).toBe('png');
  });

  it('has a real dark variant (distinct artwork, not a placeholder fallback)', () => {
    expect(CORE_IDENTITY.hasDarkLogo()).toBe(true);
    const darkLogo = CORE_IDENTITY.getLogo('dark');
    expect(darkLogo.theme).toBe('dark');
    expect(darkLogo.file).toBe('logo-dark.png');
  });

  it('cannot be mutated (Object.freeze)', () => {
    expect(() => {
      CORE_IDENTITY.name = 'Hacked';
    }).toThrow();
    expect(CORE_IDENTITY.name).toBe('DAS-Forge');
  });
});

describe('resolveVendorLogo', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prefers svg over png when both are present', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'brand-'));
    writeFileSync(path.join(tmpDir, 'logo.png'), 'fake-png');
    writeFileSync(path.join(tmpDir, 'logo.svg'), '<svg></svg>');

    const resolved = resolveVendorLogo(tmpDir);
    expect(resolved.format).toBe('svg');
  });

  it('falls back to png when no svg exists', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'brand-'));
    writeFileSync(path.join(tmpDir, 'logo.png'), 'fake-png');

    const resolved = resolveVendorLogo(tmpDir);
    expect(resolved.format).toBe('png');
  });

  it('returns null when no logo file exists yet', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'brand-'));
    expect(resolveVendorLogo(tmpDir)).toBeNull();
  });

  it('resolves a true dark variant when requested and present', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'brand-'));
    writeFileSync(path.join(tmpDir, 'logo.svg'), '<svg>light</svg>');
    writeFileSync(path.join(tmpDir, 'logo-dark.svg'), '<svg>dark</svg>');

    const resolved = resolveVendorLogo(tmpDir, { theme: 'dark' });
    expect(resolved.file).toBe('logo-dark.svg');
    expect(resolved.theme).toBe('dark');
  });

  it('falls back to the light variant when dark theme requested but missing', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'brand-'));
    writeFileSync(path.join(tmpDir, 'logo.svg'), '<svg>light</svg>');

    const resolved = resolveVendorLogo(tmpDir, { theme: 'dark' });
    expect(resolved.file).toBe('logo.svg');
    expect(resolved.theme).toBe('light'); // honest about what was actually found
  });
});

describe('defineVendorIdentity', () => {
  it('requires name and assetsDir', () => {
    expect(() => defineVendorIdentity({ assetsDir: '/tmp' })).toThrow();
    expect(() => defineVendorIdentity({ name: 'it-assets' })).toThrow();
  });
});

describe('company branding (DB-backed)', () => {
  let db;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
  });

  afterEach(() => {
    db.close();
  });

  it('returns schema defaults (all null) when nothing has been set', () => {
    const branding = getCompanyBranding(db);
    expect(branding.name).toBeNull();
    expect(branding.logoUrl).toBeNull();
  });

  it('sets and persists company branding', () => {
    setCompanyBranding(db, { name: 'Acme Corp', logoUrl: '/uploads/acme-logo.png' }, {
      actor: 'admin@acme.test',
    });
    const branding = getCompanyBranding(db);
    expect(branding.name).toBe('Acme Corp');
    expect(branding.logoUrl).toBe('/uploads/acme-logo.png');
    expect(branding.updatedBy).toBe('admin@acme.test');
    expect(branding.updatedAt).not.toBeNull();
  });

  it('shallow-merges a patch without clobbering unset fields', () => {
    setCompanyBranding(db, { name: 'Acme Corp', logoUrl: '/x.png' });
    setCompanyBranding(db, { name: 'Acme Corp Renamed' });
    const branding = getCompanyBranding(db);
    expect(branding.name).toBe('Acme Corp Renamed');
    expect(branding.logoUrl).toBe('/x.png');
  });

  it('rejects an invalid patch (name too long)', () => {
    expect(() => setCompanyBranding(db, { name: 'x'.repeat(200) })).toThrow();
  });

  it('getEffectiveBranding falls back to vendor identity when not customized', () => {
    const vendor = defineVendorIdentity({
      name: 'it-assets',
      assetsDir: path.join(__dirname, 'fixtures', 'empty-dir'),
    });
    const effective = getEffectiveBranding(db, vendor);
    expect(effective.name).toBe('it-assets');
    expect(effective.isCustomized).toBe(false);
  });

  it('getEffectiveBranding prefers company branding once set', () => {
    const vendor = defineVendorIdentity({
      name: 'it-assets',
      assetsDir: path.join(__dirname, 'fixtures', 'empty-dir'),
    });
    setCompanyBranding(db, { name: 'Acme IT', logoUrl: '/acme.png' });
    const effective = getEffectiveBranding(db, vendor);
    expect(effective.name).toBe('Acme IT');
    expect(effective.logo).toEqual({ format: 'url', path: '/acme.png', theme: 'light' });
    expect(effective.isCustomized).toBe(true);
  });

  it('getEffectiveBranding uses logoUrlDark for dark theme, falling back to logoUrl', () => {
    const vendor = defineVendorIdentity({
      name: 'it-assets',
      assetsDir: path.join(__dirname, 'fixtures', 'empty-dir'),
    });
    setCompanyBranding(db, { name: 'Acme IT', logoUrl: '/acme.png' });

    // no logoUrlDark set yet -> falls back to light logoUrl
    let effective = getEffectiveBranding(db, vendor, { theme: 'dark' });
    expect(effective.logo).toEqual({ format: 'url', path: '/acme.png', theme: 'dark' });

    setCompanyBranding(db, { logoUrlDark: '/acme-dark.png' });
    effective = getEffectiveBranding(db, vendor, { theme: 'dark' });
    expect(effective.logo).toEqual({ format: 'url', path: '/acme-dark.png', theme: 'dark' });
  });
});
