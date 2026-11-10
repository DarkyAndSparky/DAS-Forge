import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mod = await import(new URL('../../../scripts/docker-test.mjs', import.meta.url));
const script = fileURLToPath(new URL('../../../scripts/docker-test.mjs', import.meta.url));

describe('docker:test script', () => {
  it('builds the same command the documentation shows, with the working tree read-only', () => {
    const args = mod.buildDockerArgs({ cwd: 'C:\\work\\forge', tty: true });
    expect(args.slice(0, 5)).toEqual(['run', '--rm', '-it', '-v', 'C:\\work\\forge:/src:ro']);
    expect(args[5]).toBe('node:26-bookworm-slim');
    const sh = args.at(-1);
    expect(sh).toContain('tar --exclude=node_modules -C /src -cf - . | tar -C /app -xf -');
    expect(sh).toContain('npm rebuild argon2');
    expect(sh.endsWith('npm test')).toBe(true);
  });

  it('--core runs only the core tests, --image changes the image, no tty without a terminal', () => {
    const o = mod.parseArgs(['--core', '--image', 'node:current-bookworm-slim']);
    const args = mod.buildDockerArgs({ cwd: '/x', ...o });
    expect(args).not.toContain('-it');
    expect(args).toContain('node:current-bookworm-slim');
    expect(args.at(-1).endsWith('npm run test:core')).toBe(true);
  });

  it('refuses unknown arguments with exit code 2 and does not start docker', () => {
    const r = spawnSync(process.execPath, [script, '--nope'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown argument');
  });
});
