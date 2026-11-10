import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mod = await import(new URL('../../../scripts/docker-start.mjs', import.meta.url));
const script = fileURLToPath(new URL('../../../scripts/docker-start.mjs', import.meta.url));

describe('docker:start script', () => {
  it('creates a long random session secret once and keeps an existing one', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'forge-secret-'));
    const a = mod.ensureSecret(root);
    expect(a.created).toBe(true);
    const text = readFileSync(a.path, 'utf8');
    expect(text.length).toBeGreaterThanOrEqual(32);
    const b = mod.ensureSecret(root);
    expect(b.created).toBe(false);
    expect(readFileSync(b.path, 'utf8')).toBe(text);
  });

  it('replaces a secret that is too short to be safe', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'forge-secret-'));
    mkdirSync(path.join(root, 'secrets'));
    writeFileSync(path.join(root, 'secrets', 'session_secret.txt'), 'short');
    expect(mod.ensureSecret(root).created).toBe(true);
  });

  it('waitForHealth retries until the service answers and reports failure without throwing', async () => {
    let calls = 0;
    const up = await mod.waitForHealth('http://x/health', {
      fetchFn: async () => { calls += 1; if (calls < 3) throw new Error('refused'); return { ok: true }; },
      timeoutMs: 100, intervalMs: 10, sleep: async () => {},
    });
    expect(up).toEqual({ ok: true, attempts: 3 });
    const down = await mod.waitForHealth('http://x/health', { fetchFn: async () => ({ ok: false }), timeoutMs: 30, intervalMs: 10, sleep: async () => {} });
    expect(down.ok).toBe(false);
    expect(down.attempts).toBe(3);
  });

  it('refuses an unknown command with exit code 2', () => {
    const r = spawnSync(process.execPath, [script, 'explode'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage');
  });
});
