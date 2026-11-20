import { describe, it, expect } from 'vitest';
import { generateSecret, checkSecretStrength } from '../src/config/secrets.js';
import { createCli, registerSecretCommands } from '../src/cli/index.js';
import { hardeningChecks } from '../src/health/index.js';

describe('generateSecret / checkSecretStrength', () => {
  it('makes distinct base64url secrets that pass the strength check', () => {
    const a = generateSecret(); const b = generateSecret();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(checkSecretStrength(a).ok).toBe(true);
    let err; try { generateSecret(8); } catch (e) { err = e; }
    expect(err instanceof RangeError).toBe(true);
  });
  it('refuses guessable values', () => {
    for (const w of ['aaaaaaaaaaaaaaaaaaaa', 'abababababababababab', 'abcdefghijklmnopqrstuvwxyz', '12345678901234567890', 'qwertyuiop-asdfghjkl', 'changeme-please-now', 'Zx9Zx9Zx9Zx9Zx9Zx9Zx9']) {
      expect(checkSecretStrength(w).ok, w).toBe(false);
    }
  });
});

describe('secret generate command', () => {
  it('prints the requested number of secrets and rejects a bad range', async () => {
    const out = []; const origLog = console.log; const origErr = console.error;
    console.log = (x) => out.push(x);
    const cli = createCli({ name: 'app' });
    registerSecretCommands(cli);
    expect(await cli.run(['secret', 'generate', '--count', '3'])).toBe(0);
    console.log = origLog;
    expect(out).toHaveLength(3);
    expect(out.every((s) => s.length === 43)).toBe(true);
    console.error = () => {};
    expect(await cli.run(['secret', 'generate', '--bytes', '4'])).not.toBe(0);
    console.error = origErr;
  });
});

describe('internet exposure: separate TOTP key', () => {
  const cfg = (auth) => ({ server: { exposure: 'internet', https: { mode: 'standalone' }, admin: { allowedNets: ['10.0.0.0/8'] } }, auth });
  const get = (r) => r.find((c) => c.name === 'Internet exposure: encryption keys');
  it('fails without totpEncryptionKey, passes with it, absent for lan', async () => {
    expect(get(await hardeningChecks({ appConfig: cfg({}) })).status).toBe('fail');
    expect(get(await hardeningChecks({ appConfig: cfg({ totpEncryptionKey: generateSecret() }) })).status).toBe('ok');
    expect(get(await hardeningChecks({ appConfig: { server: { exposure: 'lan' }, auth: {} } }))).toBeUndefined();
  });
});

describe('doctor: backup passphrase strength', () => {
  it('warns for a short or guessable phrase, not for a good one', async () => {
    const { securityChecks } = await import('../src/health/index.js');
    const get = async (bk) => (await securityChecks({ env: 'production', auth: { sessionSecret: generateSecret() }, backup: { encryptionKey: bk } })).find((c) => c.name === 'Backup key strength');
    expect((await get('short phrase here 1'))?.status).toBe('warn');
    expect((await get('aaaaaaaaaaaaaaaaaaaaaaaaa'))?.status).toBe('warn');
    expect(await get('correct horse battery staple')).toBeUndefined();
  });
});
