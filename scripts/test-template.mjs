#!/usr/bin/env node
/**
 * Checks that templates/app still works against the CURRENT core: copies the template to a temporary folder,
 * points its @das-forge/core dependency at packages/core (a file: path instead of the not-yet-published
 * range), installs and runs the template's own tests.
 *
 *   npm run test:template
 *
 * The template is not an npm workspace (a copy of it must stand on its own), so the normal `npm test` does not
 * reach it; CI runs this script as a separate step.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** package.json text with the core dependency replaced by a file: path. Pure; tested. */
export function patchDependency(packageJsonText, corePath) {
  const pkg = JSON.parse(packageJsonText);
  if (!pkg.dependencies?.['@das-forge/core']) throw new Error('the template has no @das-forge/core dependency');
  pkg.dependencies['@das-forge/core'] = `file:${corePath.replaceAll('\\', '/')}`;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const work = mkdtempSync(path.join(os.tmpdir(), 'forge-template-'));
  const app = path.join(work, 'app');
  let code = 1;
  try {
    cpSync(path.join(root, 'templates/app'), app, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
    const pkgFile = path.join(app, 'package.json');
    writeFileSync(pkgFile, patchDependency(readFileSync(pkgFile, 'utf8'), path.join(root, 'packages/core')));
    const run = (args) => spawnSync('npm', args, { cwd: app, stdio: 'inherit', shell: process.platform === 'win32' });
    // npm >= 11 blocks dependency install scripts until approved (argon2 builds a native module).
    if (run(['install']).status === 0) {
      run(['install-scripts', 'approve', 'argon2']);
      run(['rebuild', 'argon2']);
      code = run(['test']).status ?? 1;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  process.exit(code);
}
