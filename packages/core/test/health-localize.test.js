import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { localizeDoctor, localizeMessage, localizeName, localizeCategory, runtimeChecks, securityChecks, formatDoctorText } from '../src/health/index.js';
import { DOCTOR_NAMES, DOCTOR_CATEGORIES } from '../src/health/localize.js';

const SAMPLES = [
  'connection ok', 'integrity OK', '3 applied, 0 pending', '2 pending - run `migrate`', 'v22.1.0 (requires >=26.0.0)',
  '/x does not exist yet (created by the first backup)', '/x does not exist', '/x writable', '/x exists but is not writable',
  'auth.sessionSecret is missing or shorter than 16 characters', 'self-signed in production - fine for internal tools, confirm this is intentional',
  'http on 9001 redirects to https on 9002', '127.0.0.1:9002 in use by this application', '127.0.0.1:9002 available',
  '5 h ago', '30 h ago (more than 26 h) - is the automatic backup on?', 'last verified 80 h ago (more than 48 h)',
  '12% of the heap limit', 'timer fired 5 ms late - something blocks the loop', '4 ms drift',
  'a proxy is trusted for forwarded headers', 'forwarded headers are not trusted',
  'disabled (email.enabled is false)', 'example.org: SPF and DMARC are published', 'SPF record is missing for example.org',
  'expires in 12 day(s) - run `cert renew`', 'valid (expires in 90 days)', 'not checked: nodejs.org answered 500',
  '120 packages checked: 1 high, 2 moderate, 3 accepted', '26.1.0: no newer security release in line 26.x',
  'creation date not recorded (security.secretsRotation)', '400 days old (more than 365) - rotate the key', '12 days old',
  'dangerous administration actions run without a fresh confirmation (security.stepUp.enabled is false)',
  '6 registered (sessions-gc, audit-gc)', 'standard cleanup jobs are not registered: sessions, audit, mail and tokens grow without limit (scheduler.registerStandardJobs)',
];

describe('doctor in Russian', () => {
  it('translates every sample message and leaves English untouched', () => {
    for (const s of SAMPLES) {
      const ru = localizeMessage(s, 'ru');
      expect(ru, s).not.toBe(s);
      expect(ru, s).not.toMatch(/\$\d/);
      expect(localizeMessage(s, 'en')).toBe(s);
    }
  });

  it('every check name written in the core has a Russian name', () => {
    const dirs = ['src/health/checks', 'src/email', 'src/certs'];
    const names = new Set();
    for (const d of dirs) for (const f of readdirSync(new URL(`../${d}`, import.meta.url))) {
      if (!f.endsWith('.js') || f === 'generate.js') continue;
      const code = readFileSync(new URL(`../${d}/${f}`, import.meta.url), 'utf8');
      for (const m of code.matchAll(/name: '([^'$]+)'/g)) names.add(m[1]);
    }
    for (const n of names) {
      if (['doctor', 'run'].includes(n)) continue;
      expect(DOCTOR_NAMES.includes(n) || DOCTOR_CATEGORIES.includes(n) || localizeName(n, 'ru') !== n, n).toBe(true);
    }
    expect(localizeName('Permissions: data', 'ru')).toBe('Права доступа: data');
    expect(localizeCategory('Hardening', 'ru')).toBe('Защита');
  });

  it('real checks come out in Russian and the report is not modified', () => {
    const checks = [...runtimeChecks(), ...securityChecks({ auth: { sessionSecret: 'x' }, env: 'production', server: { https: { mode: 'self-signed' } } })];
    const report = { categories: [{ name: 'Runtime', checks }], summary: { ok: 1, warn: 1, fail: 1 }, exitCode: 3 };
    const ru = localizeDoctor(report, 'ru');
    expect(ru.categories[0].name).toBe('Среда выполнения');
    expect(ru.categories[0].checks.find((c) => c.name === 'Секрет сессий').message).toContain('короче 16 символов');
    expect(report.categories[0].name).toBe('Runtime');
    expect(localizeDoctor(report, 'en')).toBe(report);
    expect(formatDoctorText(ru, { title: 'Диагностика', lang: 'ru' })).toContain('Найдено проблем');
  });
});
