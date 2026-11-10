#!/usr/bin/env node
/**
 * Starts the workshop in Docker with one command, from any shell:
 *
 *   npm run docker:start       build, start, wait until /health answers, print the address
 *   npm run docker:logs        follow the container log (the first-run administrator password is in it)
 *   npm run docker:stop        stop and remove the container (the data volume stays)
 *
 * On the first run it creates secrets/session_secret.txt (48 random characters, owner-only, never committed;
 * docker-compose.yml hands it to the container as DAS_SESSION_SECRET_FILE). An existing file is kept.
 * The container speaks plain HTTP on 127.0.0.1:9002 behind a TLS proxy you provide in production
 * (https.mode = reverse-proxy); for a local check open http://127.0.0.1:9002 directly.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEALTH_URL = 'http://127.0.0.1:9002/health';

/** Creates `<root>/secrets/session_secret.txt` unless it exists and is long enough. Returns { path, created }. */
export function ensureSecret(root) {
  const dir = path.join(root, 'secrets');
  const file = path.join(dir, 'session_secret.txt');
  if (existsSync(file) && readFileSync(file, 'utf8').trim().length >= 32) return { path: file, created: false };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, randomBytes(36).toString('base64url'), { mode: 0o600 });
  return { path: file, created: true };
}

/** Polls `url` until it answers 2xx. Resolves { ok, attempts }; never throws. */
export async function waitForHealth(url, { fetchFn = fetch, timeoutMs = 90_000, intervalMs = 2_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(Math.min(5_000, intervalMs * 2)) });
      if (res.ok) return { ok: true, attempts: i };
    } catch { /* not up yet */ }
    if (i < attempts) await sleep(intervalMs);
  }
  return { ok: false, attempts };
}

const docker = (args, root) => spawnSync('docker', args, { cwd: root, stdio: 'inherit' });

async function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cmd = argv[0] ?? 'start';
  if (!['start', 'stop', 'logs'].includes(cmd)) { console.error('usage: docker-start.mjs [start|stop|logs]'); return 2; }

  const probe = spawnSync('docker', ['compose', 'version'], { cwd: root, stdio: 'ignore' });
  if (probe.error || probe.status !== 0) { console.error('docker compose was not found: install Docker Desktop and start it.'); return 1; }

  if (cmd === 'stop') return docker(['compose', 'down'], root).status ?? 1;
  if (cmd === 'logs') return docker(['compose', 'logs', '-f', '--tail', '100', 'workshop'], root).status ?? 1;

  const secret = ensureSecret(root);
  if (secret.created) console.log(`Created ${path.relative(root, secret.path)} (session secret; keep it out of git).`);
  const up = docker(['compose', 'up', '-d', '--build'], root);
  if ((up.status ?? 1) !== 0) { console.error('docker compose up failed; see the output above.'); return up.status ?? 1; }

  console.log(`Waiting for ${HEALTH_URL} ...`);
  const r = await waitForHealth(HEALTH_URL);
  if (!r.ok) {
    console.error('The container did not become healthy in time. Look at the log: npm run docker:logs');
    return 1;
  }
  console.log([
    '',
    'Workshop is running in Docker.',
    '  address:          http://127.0.0.1:9002   (plain HTTP behind your own TLS proxy in production)',
    '  first-run admin:  npm run docker:logs     (the start banner shows the login and temporary password)',
    '  own admin:        docker compose exec workshop node bin/app.js user create-admin',
    '  stop:             npm run docker:stop     (the data volume stays; `docker compose down -v` deletes it)',
  ].join('\n'));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err.message); process.exit(1); });
}
