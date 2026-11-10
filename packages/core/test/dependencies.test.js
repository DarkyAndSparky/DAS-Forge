import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPENDENCY_PURPOSE, readCoreDependencies } from '../src/admin/dependencies.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(here, '../package.json'), 'utf8'));
const declared = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})];

describe('core dependencies are described', () => {
  it('every dependency and peer in package.json has a purpose in both languages', () => {
    const missing = declared.filter((n) => !DEPENDENCY_PURPOSE[n]?.ru || !DEPENDENCY_PURPOSE[n]?.en);
    expect(missing).toEqual([]);
  });

  it('the description table has no entries for packages the core no longer declares', () => {
    expect(Object.keys(DEPENDENCY_PURPOSE).filter((n) => !declared.includes(n))).toEqual([]);
  });

  it('load is always or lazy', () => {
    expect(Object.values(DEPENDENCY_PURPOSE).every((p) => p.load === 'always' || p.load === 'lazy')).toBe(true);
  });

  it('readCoreDependencies lists dependencies and peers (not dev packages) and marks optional peers', () => {
    const rows = readCoreDependencies();
    expect(rows.map((r) => r.name).sort()).toEqual([...declared].sort());
    expect(rows.every((r) => r.group === 'core')).toBe(true);
    expect(rows.find((r) => r.name === 'express').peer).toBe(true);
    expect(rows.find((r) => r.name === 'pino-pretty').optional).toBe(true);
    expect(rows.find((r) => r.name === 'helmet').peer).toBe(false);
    expect(rows.some((r) => r.name === 'vitest')).toBe(false);
  });

  it('the documentation lists every core dependency (npm run docs regenerates it)', () => {
    const doc = readFileSync(path.resolve(here, '../../../docs/guide/12-dependencies.md'), 'utf8');
    const missing = declared.filter((n) => !doc.includes(`\`${n}\``));
    expect(missing).toEqual([]);
    expect(doc).not.toContain('| НЕ ОПИСАН |');
  });
});
