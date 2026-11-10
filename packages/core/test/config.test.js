import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, validateConfig, ConfigValidationError } from '../src/config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');

describe('validateConfig', () => {
  it('fills in defaults for a minimal valid config', () => {
    const config = validateConfig({
      appName: 'procure-it',
      auth: { sessionSecret: 'a'.repeat(32) },
    });

    expect(config.env).toBe('development');
    expect(config.server.port).toBe(3000);
    expect(config.database.driver).toBe('node:sqlite');
    expect(config.security.csrf).toBe(true);
    expect(config.auth.argon2.timeCost).toBe(2);
  });

  it('rejects a config missing required auth.sessionSecret', () => {
    expect(() => validateConfig({ appName: 'procure-it' })).toThrow(ConfigValidationError);
  });

  it('produces the unified error shape on failure', () => {
    try {
      validateConfig({ appName: 'procure-it', auth: { sessionSecret: 'short' } });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect(err.error).toBe('VALIDATION_ERROR');
      expect(Array.isArray(err.fields)).toBe(true);
      expect(err.fields[0]).toHaveProperty('path');
      expect(err.fields[0]).toHaveProperty('message');
      expect(err.fields[0]).toHaveProperty('code');
    }
  });

  it('rejects unknown database driver (only node:sqlite allowed)', () => {
    expect(() =>
      validateConfig({
        appName: 'x',
        auth: { sessionSecret: 'a'.repeat(32) },
        database: { driver: 'better-sqlite3' },
      })
    ).toThrow(ConfigValidationError);
  });
});

describe('loadConfig', () => {
  afterEach(() => {
    delete process.env.DAS_PORT;
    delete process.env.DAS_SESSION_SECRET;
    delete process.env.DAS_ENV;
  });

  it('loads and validates app.config.js from a fixture directory', async () => {
    const config = await loadConfig({ cwd: path.join(fixturesDir, 'valid-app') });
    expect(config.appName).toBe('it-assets');
    expect(config.server.port).toBe(4100);
  });

  it('throws ConfigValidationError for an invalid fixture config', async () => {
    await expect(
      loadConfig({ cwd: path.join(fixturesDir, 'invalid-app') })
    ).rejects.toThrow(ConfigValidationError);
  });

  it('falls back to schema defaults when no app.config.js exists (overrides only)', async () => {
    const config = await loadConfig({
      cwd: path.join(fixturesDir, 'empty-dir'),
      overrides: { appName: 'net-monitor', auth: { sessionSecret: 'b'.repeat(20) } },
    });
    expect(config.appName).toBe('net-monitor');
    expect(config.server.host).toBe('127.0.0.1');
  });

  it('applies env var overrides on top of file config, still validated', async () => {
    process.env.DAS_PORT = '9999';
    process.env.DAS_SESSION_SECRET = 'c'.repeat(40);
    process.env.DAS_ENV = 'production';

    const config = await loadConfig({ cwd: path.join(fixturesDir, 'valid-app') });

    expect(config.server.port).toBe(9999);
    expect(config.auth.sessionSecret).toBe('c'.repeat(40));
    expect(config.env).toBe('production');
  });

  it('throws a plain Error (not ConfigValidationError) when an explicit configPath is missing', async () => {
    await expect(
      loadConfig({ configPath: path.join(fixturesDir, 'does-not-exist.js') })
    ).rejects.toThrow(/Config file not found/);
  });
});
