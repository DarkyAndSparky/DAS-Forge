import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validateConfig, loadConfig, ApplicationConfigSchema, ConfigValidationError } from '../src/config/index.js';

const base = { appName: 'x', auth: { sessionSecret: 'a'.repeat(32) } };

function failure(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

describe('strict configuration (audit C07)', () => {
  it('a mistyped key at any depth is an error that names the key', () => {
    const top = failure(() => validateConfig({ ...base, sever: { port: 1 } }));
    expect(top).toBeInstanceOf(ConfigValidationError);
    expect(top.fields.map((f) => f.path)).toContain('sever');

    const nested = failure(() => validateConfig({ ...base, server: { prot: 8080 } }));
    expect(nested.fields.map((f) => f.path)).toContain('server.prot');
    expect(nested.fields[0].message).toMatch(/Unknown setting "prot"/);

    const deep = failure(() => validateConfig({ ...base, server: { https: { mod: 'standalone' } } }));
    expect(deep.fields.map((f) => f.path)).toContain('server.https.mod');
  });

  it('several unknown keys give one field each', () => {
    const e = failure(() => validateConfig({ ...base, foo: 1, bar: 2 }));
    expect(e.fields.map((f) => f.path).sort()).toEqual(['bar', 'foo']);
  });

  it('every documented section still validates with its real keys', () => {
    const cfg = validateConfig({
      ...base,
      env: 'test',
      logLevel: 'warn',
      server: { host: '0.0.0.0', port: 8080, trustProxy: true, https: { mode: 'reverse-proxy' }, bodyLimit: '2mb', admin: { port: 9090 } },
      database: { file: 'x.db', walMode: false },
      backup: { enabled: false, schedule: '0 2 * * *', retentionDays: 5, destinations: [{ id: 'l', type: 'local', path: 'b' }] },
      uploads: { maxTotalBytes: 0, maxFiles: 10 },
      ui: { theme: 't', title: 'T', locale: 'en' },
      modules: [{ name: 'm', enabled: true, options: { anything: 1 } }],
      security: {
        cors: { origins: ['https://a.example'] },
        csrf: true,
        rateLimit: { windowMs: 1000, max: 5 },
        loginRateLimit: { windowMs: 1000, max: 2 },
        lockout: { maxFailures: 3, baseLockMs: 1000, maxLockMs: 5000 },
        incidentContacts: ['ops@example.com'],
      },
      auth: { sessionSecret: 'a'.repeat(32), sessionTtlMs: 1000, sessionIdleTimeoutMs: 0, passwordPolicy: { minLength: 10, maxLength: 64 }, argon2: { memoryCost: 8192, timeCost: 1, parallelism: 1 }, totp: { enabled: true } },
      performance: { budgets: { p95HealthMs: 10, p95ApiMs: 100 } },
    });
    expect(cfg.uploads.maxFiles).toBe(10);
    expect(cfg.modules[0].options).toEqual({ anything: 1 });
  });

  it('an app extends the schema with its own section and passes it as `schema`', async () => {
    const schema = ApplicationConfigSchema.extend({ mailer: z.strictObject({ from: z.string() }) });
    const cfg = validateConfig({ ...base, mailer: { from: 'a@b.c' } }, { schema });
    expect(cfg.mailer.from).toBe('a@b.c');
    expect(failure(() => validateConfig({ ...base, mailer: { frm: 'x' } }, { schema })).fields.map((f) => f.path)).toContain('mailer.frm');
    // the core schema alone still refuses the section
    expect(failure(() => validateConfig({ ...base, mailer: { from: 'a@b.c' } }))).toBeInstanceOf(ConfigValidationError);

    const loaded = await loadConfig({ cwd: '/nonexistent-dir-for-test', overrides: { ...base, mailer: { from: 'a@b.c' } }, env: {}, schema });
    expect(loaded.mailer.from).toBe('a@b.c');
  });
});

describe('email configuration', () => {
  const email = (e) => validateConfig({ ...base, email: e }).email;
  // (the helper above throws for invalid input, which `failure()` below catches)

  it('is off by default and needs nothing', () => {
    const cfg = validateConfig(base);
    expect(cfg.email.enabled).toBe(false);
    expect(cfg.email.smtp.port).toBe(587);
    expect(cfg.email.smtp.requireTLS).toBe(true);
    expect(cfg.email.smtp.rejectUnauthorized).toBe(true);
  });

  it('enabled requires from and smtp.host', () => {
    const e = failure(() => validateConfig({ ...base, email: { enabled: true } }));
    expect(e.fields.map((f) => f.path).sort()).toEqual(['email.baseUrl', 'email.from', 'email.smtp.host']);
    expect(email({ enabled: true, from: 'a@b.co', baseUrl: 'https://app.example.com', smtp: { host: 'smtp.example.com' } }).smtp.host).toBe('smtp.example.com');
  });

  it('auth needs both user and pass; dkim needs exactly one key source; typos are refused', () => {
    expect(failure(() => email({ smtp: { auth: { user: 'u' } } }))).toBeInstanceOf(ConfigValidationError);
    expect(failure(() => email({ dkim: { domainName: 'a.co', keySelector: 's' } }))).toBeInstanceOf(ConfigValidationError);
    expect(failure(() => email({ dkim: { domainName: 'a.co', keySelector: 's', privateKey: 'k', privateKeyFile: 'f' } }))).toBeInstanceOf(ConfigValidationError);
    expect(email({ dkim: { domainName: 'a.co', keySelector: 's', privateKeyFile: 'dkim.pem' } }).dkim.keySelector).toBe('s');
    expect(failure(() => email({ smtp: { hots: 'x' } })).fields.map((f) => f.path)).toContain('email.smtp.hots');
  });
});
