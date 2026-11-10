import { describe, it, expect } from 'vitest';
import { formatStartBanner } from '../src/banner.js';

describe('start banner', () => {
  const base = { url: 'https://localhost:4321', credentialsFile: '/d/first-run-admin.txt' };
  it('first start: shows login and the temporary password', () => {
    const t = formatStartBanner({ ...base, bootstrap: { created: true, username: 'admin', tempPassword: 'Secret123' } });
    expect(t).toContain('логин / login:       admin');
    expect(t).toContain('пароль / password:   Secret123');
    expect(t).toContain('https://localhost:4321/admin');
    expect(t).toContain('The password is temporary');
    expect(t).toContain('Пароль временный');
  });
  it('DAS_BOOTSTRAP_PRINT=false hides the password', () => {
    const t = formatStartBanner({ ...base, bootstrap: { created: true, username: 'admin', tempPassword: 'Secret123' }, showPassword: false });
    expect(t).not.toContain('Secret123');
  });
  it('shows the application and core versions', () => {
    const t = formatStartBanner({ ...base, appVersion: '0.1.0', coreVersion: '0.1.104', bootstrap: { created: false } });
    expect(t).toContain('Workshop 0.1.0');
    expect(t).toContain('DAS-Forge core 0.1.104');
  });
  it('later starts: no credentials, only a reset hint; "=" lines frame the lettering and the rows', () => {
    const t = formatStartBanner({ ...base, bootstrap: { created: false } });
    expect(t).not.toContain('пароль / password:');
    expect(t).toContain('reset-password');
    const lines = t.split('\n');
    const bars = lines.filter((l) => /^ {2}=+$/.test(l));
    expect(bars).toHaveLength(3);
    expect(lines.at(-1)).toBe(bars[2]);
    expect(lines.every((l) => l === '' || l.startsWith('  '))).toBe(true);
  });
  it('with a separate admin port the panel line shows that port, not the application port', () => {
    const t = formatStartBanner({ ...base, adminUrls: ['https://localhost:9103', 'https://127.0.0.1:9103'], bootstrap: { created: false } });
    expect(t).toContain('https://localhost:9103/admin');
    expect(t).toContain('https://127.0.0.1:9103/admin');
    expect(t).not.toContain('https://localhost:4321/admin');
    expect(t).toContain('on this port only');
  });
});
