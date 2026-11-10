#!/usr/bin/env node
/**
 * Runs the tests in a clean Linux container, from any shell (PowerShell, cmd, bash):
 *
 *   npm run docker:test              all tests (npm test)
 *   npm run docker:test -- --core    only the core package (npm run test:core)
 *   npm run docker:test -- --image node:current-bookworm-slim
 *
 * The working tree is mounted read-only and copied into the container without node_modules, so native
 * packages (argon2, sharp) are built again for Linux and the Windows ones stay untouched.
 * The command line is built by `buildDockerArgs`, which the test checks; nothing here needs a shell.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_IMAGE = 'node:26-bookworm-slim';

/** The container script: copy, install, build argon2, run the tests. */
export function containerScript({ core = false } = {}) {
  return [
    'mkdir /app',
    'tar --exclude=node_modules -C /src -cf - . | tar -C /app -xf -',
    'cd /app',
    'npm install',
    'npm install-scripts approve argon2',
    'npm rebuild argon2',
    core ? 'npm run test:core' : 'npm test',
  ].join(' && ');
}

/** `docker run …` arguments (without the leading `docker`). */
export function buildDockerArgs({ cwd, image = DEFAULT_IMAGE, core = false, tty = false } = {}) {
  if (!cwd) throw new TypeError('buildDockerArgs: cwd is required');
  return ['run', '--rm', ...(tty ? ['-it'] : []), '-v', `${cwd}:/src:ro`, image, 'bash', '-c', containerScript({ core })];
}

export function parseArgs(argv) {
  const out = { core: false, image: DEFAULT_IMAGE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--core') out.core = true;
    else if (argv[i] === '--image' && argv[i + 1]) out.image = argv[++i];
    else throw new Error(`unknown argument "${argv[i]}" (use --core, --image <name>)`);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exit(2); }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = buildDockerArgs({ cwd: root, ...opts, tty: Boolean(process.stdin.isTTY) });
  const r = spawnSync('docker', args, { stdio: 'inherit' });
  if (r.error) {
    console.error(r.error.code === 'ENOENT' ? 'docker was not found: install Docker Desktop and start it.' : r.error.message);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}
