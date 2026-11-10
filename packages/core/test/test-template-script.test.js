import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { patchDependency } = await import(new URL('../../../scripts/test-template.mjs', import.meta.url));
const templatePkg = readFileSync(fileURLToPath(new URL('../../../templates/app/package.json', import.meta.url)), 'utf8');

describe('test-template script', () => {
  it('points the core dependency at a file: path and keeps everything else', () => {
    const out = JSON.parse(patchDependency(templatePkg, 'C:\\forge\\packages\\core'));
    expect(out.dependencies['@das-forge/core']).toBe('file:C:/forge/packages/core');
    expect(out.dependencies.express).toBe(JSON.parse(templatePkg).dependencies.express);
    expect(out.scripts.test).toBe('vitest run');
  });

  it('refuses a package without the core dependency', () => {
    expect(() => patchDependency('{"dependencies":{}}', '/x')).toThrow('no @das-forge/core');
  });
});

describe('the application template', () => {
  const pkg = JSON.parse(templatePkg);

  it('is not a workspace member and does not claim a published core before its release', () => {
    const root = JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'));
    expect(root.workspaces.some((w) => 'templates/app'.startsWith(w.replace('*', '')))).toBe(false);
    expect(pkg.dependencies['@das-forge/core']).toMatch(/^\^0\.\d+\.\d+$/);
  });

  it('depends on exactly what the workshop depends on for the same jobs', () => {
    const shop = JSON.parse(readFileSync(fileURLToPath(new URL('../../../examples/workshop/package.json', import.meta.url)), 'utf8'));
    for (const name of ['express', 'cookie-parser', 'express-session', 'i18next', 'zod']) expect(pkg.dependencies[name], name).toBe(shop.dependencies[name]);
    for (const name of ['vitest', 'supertest']) expect(pkg.devDependencies[name], name).toBe(shop.devDependencies[name]);
  });
});
