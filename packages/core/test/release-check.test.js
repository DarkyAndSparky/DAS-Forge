import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const script = fileURLToPath(new URL('../../../scripts/release-check.mjs', import.meta.url));
const version = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

describe('release check', () => {
  it('accepts the current version with its own tag', () => {
    const r = run(`v${version}`);
    // Until the maintainer fills in the contact addresses, the only acceptable problems are the placeholders.
    const other = r.stderr.split('\n').filter((l) => l.startsWith('- ') && !l.includes('still has the placeholder'));
    expect(other, r.stderr).toEqual([]);
    if (r.status === 0) expect(r.stdout).toContain(`@das-forge/core@${version}`);
    else expect(r.stderr).toContain('placeholder');
  });

  it('refuses a tag that is not the package version, and says why', () => {
    const r = run('v99.0.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('does not match the package version');
  });
});
