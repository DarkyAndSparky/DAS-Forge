import { describe, it, expect } from 'vitest';
import { createEmailService, renderEmail, EmailError, checkMailDomainDns, SCENARIOS } from '../src/email/index.js';

function fakeTransport({ fail } = {}) {
  const sent = [];
  return {
    sent,
    sendMail: async (m) => {
      if (fail) throw Object.assign(new Error('boom: password=hunter2'), { code: fail });
      sent.push(m);
      return { messageId: `<id-${sent.length}@x>` };
    },
    verify: async () => {
      if (fail) throw Object.assign(new Error('nope'), { code: fail });
    },
  };
}

const cfg = { enabled: true, from: 'DAS <noreply@example.com>', locale: 'ru', rateLimit: { perRecipientMax: 2, windowMs: 1000 } };
const catcher = async (p) => p.then(() => null, (e) => e);

describe('email templates', () => {
  it('every scenario renders in ru and en with subject, text and html', () => {
    const data = {
      alert: { title: 'Disk', message: 'full', severity: 'warning' },
      passwordReset: { resetUrl: 'https://app.example.com/r?t=1', expiresInMinutes: 30 },
      passwordChanged: {},
      emailVerification: { verifyUrl: 'https://app.example.com/v?t=1' },
      accountBanned: { reason: 'abuse', until: '2026-12-01' },
      accountUnbanned: {},
      newDeviceLogin: { when: '2026-10-31 01:00:00 UTC', ip: '203.0.113.7', device: 'Chrome / Windows' },
      userInvited: { inviteUrl: 'https://app.example.com/i?t=1', invitedBy: 'Ann' },
      systemNotice: { subject: 'Maintenance', message: 'Tonight' },
    };
    expect(Object.keys(data).sort()).toEqual(Object.keys(SCENARIOS).sort());
    for (const [name, d] of Object.entries(data)) {
      for (const locale of ['ru', 'en']) {
        const r = renderEmail(name, d, { locale });
        expect(r.subject.length > 0).toBe(true);
        expect(r.text.length > 0).toBe(true);
        expect(r.html).toMatch(/<html/);
      }
    }
    expect(renderEmail('passwordReset', data.passwordReset, { locale: 'ru' }).subject).toBe('Сброс пароля');
    expect(renderEmail('passwordReset', data.passwordReset, { locale: 'en' }).subject).toBe('Password reset');
  });

  it('escapes HTML in every field and keeps line breaks out of the subject', () => {
    const r = renderEmail('alert', { title: 'x\r\nBcc: evil@example.com <script>', message: '<img src=x onerror=alert(1)>', severity: 'critical' });
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.html).not.toMatch(/<script>|<img/);
    expect(r.html).toMatch(/&lt;img/);
  });

  it('links must be http(s); javascript: and garbage are refused', () => {
    for (const resetUrl of ['javascript:alert(1)', 'data:text/html,x', 'not a url', 'ftp://x/y']) {
      expect(() => renderEmail('passwordReset', { resetUrl, expiresInMinutes: 10 })).toThrow(/URL|http/);
    }
    // URL normalisation percent-encodes the quote, and the ampersand is HTML-escaped on top
    expect(renderEmail('passwordReset', { resetUrl: 'https://a.example/x?a=1&b="2"', expiresInMinutes: 10 }).html).toMatch(/a=1&amp;b=%222%22/);
  });

  it('missing / invalid fields are named in the error; unknown scenario refused', () => {
    expect(() => renderEmail('passwordReset', { resetUrl: 'https://a.example' })).toThrow(/expiresInMinutes is required/);
    expect(() => renderEmail('alert', { title: 't', message: 'm', severity: 'panic' })).toThrow(/severity/);
    expect(() => renderEmail('nope', {})).toThrow(/Unknown e-mail scenario/);
  });
});

describe('email service', () => {
  it('sends through the transport with from, plain recipients and auto-reply suppression', async () => {
    const transport = fakeTransport();
    const svc = createEmailService({ config: cfg, transport });
    const r = await svc.sendPasswordChanged({ to: 'ann@example.com', locale: 'en' });
    expect(r).toEqual({ sent: true, messageId: '<id-1@x>' });
    expect(transport.sent[0]).toMatchObject({ from: 'DAS <noreply@example.com>', to: ['ann@example.com'], subject: 'Your password was changed' });
    expect(transport.sent[0].headers['Auto-Submitted']).toBe('auto-generated');
  });

  it('sendTest sends one letter at once, skipping the queue, and surfaces a failure as an EmailError', async () => {
    const transport = fakeTransport();
    const queued = [];
    const svc = createEmailService({ config: cfg, transport, queue: { enqueue: (m) => { queued.push(m); return { id: 1 }; } } });
    const r = await svc.sendTest({ to: 'ann@example.com', locale: 'en' });
    expect(r.sent).toBe(true);
    expect(queued).toEqual([]);
    expect(transport.sent[0].subject).toBe('Mail delivery test');
    await expect(svc.sendTest({ to: ['a@b.co', 'c@d.co'] })).rejects.toThrow();
    const bad = createEmailService({ config: cfg, transport: fakeTransport({ fail: 'EAUTH' }) });
    const err = await catcher(bad.sendTest({ to: 'ann@example.com' }));
    expect(err instanceof EmailError).toBe(true);
    expect(err.message).not.toContain('hunter2');
    expect(await createEmailService({ config: { ...cfg, enabled: false } }).sendTest({ to: 'a@b.co' })).toEqual({ sent: false, skipped: 'disabled' });
  });

  it('disabled service does nothing but still validates input', async () => {
    const transport = fakeTransport();
    const svc = createEmailService({ config: { enabled: false }, transport: undefined });
    expect(await svc.sendPasswordChanged({ to: 'ann@example.com' })).toEqual({ sent: false, skipped: 'disabled' });
    expect((await catcher(svc.sendPasswordChanged({ to: 'bad' }))) instanceof TypeError).toBe(true);
    expect(transport.sent).toHaveLength(0);
  });

  it('refuses recipients that could smuggle headers or extra addresses', async () => {
    const svc = createEmailService({ config: cfg, transport: fakeTransport() });
    for (const to of ['a@b.co\r\nBcc: x@y.zz', 'Ann <a@b.co>', 'a@b.co, c@d.co', '', [], Array(21).fill('a@b.co')]) {
      expect((await catcher(svc.sendPasswordChanged({ to }))) instanceof TypeError).toBe(true);
    }
  });

  it('per-recipient limit: the third message in the window is skipped, another recipient and scenario are not', async () => {
    let t = 0;
    const transport = fakeTransport();
    const svc = createEmailService({ config: cfg, transport, now: () => t });
    expect((await svc.sendPasswordChanged({ to: 'a@example.com' })).sent).toBe(true);
    expect((await svc.sendPasswordChanged({ to: 'A@example.com' })).sent).toBe(true);
    expect(await svc.sendPasswordChanged({ to: 'a@example.com' })).toEqual({ sent: false, skipped: 'rate-limited' });
    expect((await svc.sendPasswordChanged({ to: 'b@example.com' })).sent).toBe(true);
    expect((await svc.sendAccountUnbanned({ to: 'a@example.com' })).sent).toBe(true);
    t = 1500;
    expect((await svc.sendPasswordChanged({ to: 'a@example.com' })).sent).toBe(true);
  });

  it('a critical alert is never rate-limited', async () => {
    const svc = createEmailService({ config: cfg, transport: fakeTransport() });
    for (let i = 0; i < 5; i++) expect((await svc.sendAlert({ to: 'ops@example.com', title: 'down', message: 'x', severity: 'critical' })).sent).toBe(true);
  });

  it('transport failures become EmailError with a stable code and no secrets in the message', async () => {
    for (const [code, expected] of [['EAUTH', 'EMAIL_AUTH'], ['ETIMEDOUT', 'EMAIL_UNREACHABLE'], ['EENVELOPE', 'EMAIL_REJECTED'], ['EWHATEVER', 'EMAIL_SEND_FAILED']]) {
      const svc = createEmailService({ config: cfg, transport: fakeTransport({ fail: code }) });
      const err = await catcher(svc.sendPasswordChanged({ to: 'a@example.com' }));
      expect(err instanceof EmailError).toBe(true);
      expect(err.code).toBe(expected);
      expect(err.message).not.toMatch(/hunter2/);
    }
  });

  it('logs the scenario and a masked address, never the link', async () => {
    const lines = [];
    const logger = { info: (m, f) => lines.push([m, f]), warn() {}, error() {} };
    const svc = createEmailService({ config: cfg, transport: fakeTransport(), logger });
    await svc.sendPasswordReset({ to: 'ann@example.com', resetUrl: 'https://a.example/reset?token=SECRET', expiresInMinutes: 15 });
    const dump = JSON.stringify(lines);
    expect(dump).toMatch(/passwordReset/);
    expect(dump).toMatch(/a\*\*\*@example\.com/);
    expect(dump).not.toMatch(/SECRET|ann@/);
  });

  it('an override changes the look of a scenario but its fields are still validated; unknown overrides are refused', async () => {
    const transport = fakeTransport();
    const svc = createEmailService({
      config: cfg,
      transport,
      overrides: { passwordChanged: (d, locale) => ({ subject: `custom-${locale}`, text: 't', html: '<p>h</p>' }) },
    });
    await svc.sendPasswordChanged({ to: 'a@example.com' });
    expect(transport.sent[0].subject).toBe('custom-ru');
    expect(() => createEmailService({ config: cfg, transport, overrides: { nope: () => ({}) } })).toThrow(/unknown scenario/);
  });

  it('verify() reports instead of throwing', async () => {
    expect(await createEmailService({ config: cfg, transport: fakeTransport() }).verify()).toEqual({ ok: true });
    const bad = await createEmailService({ config: cfg, transport: fakeTransport({ fail: 'EAUTH' }) }).verify();
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/login/);
    expect(await createEmailService({ config: { enabled: false } }).verify()).toEqual({ ok: false, error: 'disabled' });
  });
});

describe('checkMailDomainDns', () => {
  const resolver = (records) => ({
    resolveTxt: async (name) => {
      if (!(name in records)) throw Object.assign(new Error('nx'), { code: 'ENODATA' });
      return records[name].map((r) => [r.slice(0, 20), r.slice(20)]);
    },
  });

  it('a healthy domain has no warnings', async () => {
    const r = await checkMailDomainDns('example.com', { resolver: resolver({ 'example.com': ['v=spf1 include:_spf.example.net -all'], '_dmarc.example.com': ['v=DMARC1; p=reject; rua=mailto:d@example.com'] }) });
    expect(r.warnings).toEqual([]);
    expect(r.spf).toMatchObject({ found: true, all: '-' });
    expect(r.dmarc).toMatchObject({ found: true, policy: 'reject' });
  });

  it('missing records and weak policies produce warnings', async () => {
    const none = await checkMailDomainDns('example.com', { resolver: resolver({}) });
    expect(none.warnings).toHaveLength(2);
    const weak = await checkMailDomainDns('example.com', { resolver: resolver({ 'example.com': ['v=spf1 +all'], '_dmarc.example.com': ['v=DMARC1; p=none'] }) });
    expect(weak.warnings).toHaveLength(2);
    expect(weak.warnings.join(' ')).toMatch(/SPF.*-all|DMARC.*none/);
  });

  it('other DNS errors are not swallowed', async () => {
    const broken = { resolveTxt: async () => { throw Object.assign(new Error('servfail'), { code: 'ESERVFAIL' }); } };
    expect((await catcher(checkMailDomainDns('example.com', { resolver: broken }))).code).toBe('ESERVFAIL');
  });
});

describe('delivery retries (повторы)', () => {
  const base = { enabled: true, from: 'app@example.com', baseUrl: 'https://app.example.com', retry: { attempts: 3, baseDelayMs: 100 } };
  function flaky(failures) {
    const calls = [];
    return {
      calls,
      sendMail: async () => {
        calls.push(1);
        if (calls.length <= failures.length) throw failures[calls.length - 1];
        return { messageId: 'ok' };
      },
    };
  }
  const run = (transport, sleeps) =>
    createEmailService({ config: base, transport, sleep: async (ms) => sleeps.push(ms), random: () => 1 }).sendPasswordChanged({ to: 'a@example.com' });

  it('retries a temporary failure with doubling pauses and then succeeds', async () => {
    const t = flaky([Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), Object.assign(new Error('y'), { responseCode: 451 })]);
    const sleeps = [];
    const r = await run(t, sleeps);
    expect(r.sent).toBe(true);
    expect(t.calls.length).toBe(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it('gives up after the last attempt with the right error code', async () => {
    const t = flaky(Array.from({ length: 5 }, () => Object.assign(new Error('x'), { code: 'ECONNREFUSED' })));
    await expect(run(t, [])).rejects.toMatchObject({ code: 'EMAIL_UNREACHABLE' });
    expect(t.calls.length).toBe(3);
  });

  it('never retries a login, recipient or permanent (5xx) failure', async () => {
    for (const err of [Object.assign(new Error('a'), { code: 'EAUTH' }), Object.assign(new Error('b'), { code: 'EENVELOPE' }), Object.assign(new Error('c'), { responseCode: 550 })]) {
      const t = flaky([err]);
      await expect(run(t, [])).rejects.toBeInstanceOf(EmailError);
      expect(t.calls.length).toBe(1);
    }
  });
});
