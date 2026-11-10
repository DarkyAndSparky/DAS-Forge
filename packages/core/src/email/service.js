import { readFileSync } from 'node:fs';

import { renderEmail, SCENARIOS } from './templates.js';
import { backoffDelay } from '../util/backoff.js';

/** Thrown for a failed delivery; `code` is stable, `message` never contains credentials. */
export class EmailError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = 'EmailError';
    this.code = code;
  }
}

const ADDRESS = /^[^\s@<>"',;()[\]\\]+@[^\s@<>"',;()[\]\\]+\.[^\s@<>"',;()[\]\\]+$/;
const MAX_RECIPIENTS = 20;

function normalizeRecipients(to) {
  const list = Array.isArray(to) ? to : [to];
  if (list.length === 0 || list.length > MAX_RECIPIENTS) throw new TypeError(`E-mail needs 1..${MAX_RECIPIENTS} recipients`);
  for (const a of list) {
    if (typeof a !== 'string' || a.length > 254 || !ADDRESS.test(a)) throw new TypeError('E-mail recipient is not a plain address (name <addr> forms are not accepted)');
  }
  return list.map((a) => a.trim());
}

function maskAddress(a) {
  const [local, domain] = a.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

/** A failure worth another try: network trouble or a temporary (4xx) SMTP answer. Never auth/recipient/5xx. */
function isTransient(err) {
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED', 'EDNS'].includes(err?.code)) return true;
  const rc = Number(err?.responseCode);
  return Number.isInteger(rc) && rc >= 400 && rc < 500;
}

function toEmailError(err) {
  const code = err?.code;
  if (code === 'EAUTH') return new EmailError('EMAIL_AUTH', 'SMTP server refused the login', { cause: err });
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED', 'ENOTFOUND', 'EDNS'].includes(code)) {
    return new EmailError('EMAIL_UNREACHABLE', `SMTP server is unreachable (${code})`, { cause: err });
  }
  if (code === 'EENVELOPE') return new EmailError('EMAIL_REJECTED', 'SMTP server rejected the recipients', { cause: err });
  return new EmailError('EMAIL_SEND_FAILED', `E-mail could not be sent${code ? ` (${code})` : ''}`, { cause: err });
}

/**
 * The system-mail service of one app.
 *
 * @param {object} opts
 * @param {object} opts.config - `appConfig.email` (see EmailConfigSchema)
 * @param {{info: Function, warn: Function}} [opts.logger]
 * @param {{sendMail: Function, verify?: Function}} [opts.transport] - injected transport (tests); otherwise nodemailer is created lazily from config.smtp
 * @param {string} [opts.brandName]
 * @param {Record<string, (data: object, locale: string) => {subject: string, text: string, html: string}>} [opts.overrides] - replace the look of a scenario, never remove it
 * @param {{enqueue: (mail: object, meta: {scenario: string}) => {id: number}}} [opts.queue] - persistent queue (email/queue.js): mails are stored and sent in the background instead of inside the call; the queue's `send` should be this service's `sendRaw`
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep] - backoff wait (tests)
 * @param {() => number} [opts.random] - [0, 1) source for the retry jitter (tests)
 */
export function createEmailService({ config, logger, transport, brandName = 'DAS-Forge', overrides = {}, queue = null, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random } = {}) {
  if (!config || typeof config !== 'object') throw new TypeError('createEmailService: config is required');
  for (const name of Object.keys(overrides)) {
    if (!SCENARIOS[name]) throw new TypeError(`createEmailService: override for unknown scenario "${name}"`);
  }
  const enabled = Boolean(config.enabled) || Boolean(transport);
  const { perRecipientMax = 5, windowMs = 3_600_000 } = config.rateLimit ?? {};
  const { attempts = 3, baseDelayMs = 500 } = config.retry ?? {};
  const sentLog = new Map(); // "<scenario>|<address>" -> timestamps

  let transportPromise = transport ? Promise.resolve(transport) : null;
  function getTransport() {
    transportPromise ??= import('nodemailer').then((m) => {
      const nodemailer = m.default ?? m;
      const smtp = config.smtp ?? {};
      const options = {
        host: smtp.host,
        port: smtp.port ?? 587,
        secure: Boolean(smtp.secure),
        requireTLS: !smtp.secure && smtp.requireTLS !== false,
        tls: { rejectUnauthorized: smtp.rejectUnauthorized !== false },
        auth: smtp.auth,
        connectionTimeout: smtp.connectionTimeoutMs ?? 10_000,
        socketTimeout: smtp.socketTimeoutMs ?? 30_000,
      };
      if (config.dkim) {
        const privateKey = config.dkim.privateKey ?? readFileSync(config.dkim.privateKeyFile, 'utf8');
        options.dkim = { domainName: config.dkim.domainName, keySelector: config.dkim.keySelector, privateKey };
      }
      return nodemailer.createTransport(options);
    });
    return transportPromise;
  }

  function rateLimited(scenario, severity, recipients) {
    // A critical alert to the operators must not be swallowed by a hourly budget.
    if (scenario === 'alert' && severity === 'critical') return false;
    const t = now();
    for (const a of recipients) {
      const key = `${scenario}|${a.toLowerCase()}`;
      const recent = (sentLog.get(key) ?? []).filter((x) => t - x < windowMs);
      if (recent.length >= perRecipientMax) {
        sentLog.set(key, recent);
        return true;
      }
    }
    for (const a of recipients) {
      const key = `${scenario}|${a.toLowerCase()}`;
      sentLog.set(key, [...(sentLog.get(key) ?? []).filter((x) => t - x < windowMs), t]);
    }
    return false;
  }

  /** @returns {Promise<{sent: boolean, skipped?: 'disabled'|'rate-limited', messageId?: string}>} */
  async function deliver(scenario, to, data, { locale } = {}) {
    const recipients = normalizeRecipients(to);
    const lang = locale ?? config.locale ?? 'ru';
    const message = overrides[scenario] ? overrides[scenario](data, lang) : renderEmail(scenario, data, { locale: lang, brandName });
    if (overrides[scenario]) renderEmail(scenario, data, { locale: lang, brandName }); // still validates the fields
    if (!enabled) return { sent: false, skipped: 'disabled' };
    if (rateLimited(scenario, data?.severity, recipients)) {
      logger?.warn?.('email skipped: per-recipient limit reached', { scenario });
      return { sent: false, skipped: 'rate-limited' };
    }
    const mail = {
      from: config.from,
      replyTo: config.replyTo,
      to: recipients,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
    };
    if (queue) {
      const { id } = queue.enqueue(mail, { scenario });
      logger?.info?.('email queued', { scenario, to: recipients.map(maskAddress), queueId: id });
      return { sent: false, queued: true, queueId: id };
    }
    return sendRaw(mail, { scenario });
  }

  /**
   * Sends one prepared mail now (with the in-process retries for temporary SMTP
   * trouble). This is what the persistent queue calls; apps normally use the
   * named scenarios below instead.
   */
  async function sendRaw(mail, { scenario = 'mail' } = {}) {
    const recipients = mail.to;
    try {
      let info;
      for (let attempt = 1; ; attempt++) {
        try {
          info = await (await getTransport()).sendMail(mail);
          break;
        } catch (err) {
          if (attempt >= attempts || !isTransient(err)) throw err;
          logger?.warn?.('email attempt failed, retrying', { scenario, attempt, code: err?.code ?? err?.responseCode });
          await sleep(backoffDelay(attempt, { baseMs: baseDelayMs, random }));
        }
      }
      // Only the scenario and a masked address are logged: bodies carry reset/invite links.
      logger?.info?.('email sent', { scenario, to: recipients.map(maskAddress), messageId: info?.messageId });
      return { sent: true, messageId: info?.messageId };
    } catch (err) {
      const wrapped = toEmailError(err);
      logger?.error?.('email failed', { scenario, code: wrapped.code });
      throw wrapped;
    }
  }

  return {
    enabled,
    sendRaw,
    sendAlert: ({ to, title, message, severity = 'info', locale }) => deliver('alert', to, { title, message, severity }, { locale }),
    sendPasswordReset: ({ to, resetUrl, expiresInMinutes, locale }) => deliver('passwordReset', to, { resetUrl, expiresInMinutes }, { locale }),
    sendPasswordChanged: ({ to, locale }) => deliver('passwordChanged', to, {}, { locale }),
    sendNewDeviceLogin: ({ to, when, ip, device, locale }) => deliver('newDeviceLogin', to, { when, ip, device }, { locale }),
    sendEmailVerification: ({ to, verifyUrl, locale }) => deliver('emailVerification', to, { verifyUrl }, { locale }),
    sendAccountBanned: ({ to, reason, until, locale }) => deliver('accountBanned', to, { reason, until }, { locale }),
    sendAccountUnbanned: ({ to, locale }) => deliver('accountUnbanned', to, {}, { locale }),
    sendUserInvited: ({ to, inviteUrl, invitedBy, locale }) => deliver('userInvited', to, { inviteUrl, invitedBy }, { locale }),
    sendSystemNotice: ({ to, subject, message, locale }) => deliver('systemNotice', to, { subject, message }, { locale }),
    /**
     * A test letter to one address, sent right now and NOT through the queue,
     * so the answer is the real SMTP result (an EmailError with a stable code
     * when it fails). For the administration panel's "Send a test letter".
     */
    async sendTest({ to, locale }) {
      const recipients = normalizeRecipients(to);
      if (recipients.length !== 1) throw new TypeError('sendTest: exactly one recipient');
      if (!enabled) return { sent: false, skipped: 'disabled' };
      const lang = locale ?? config.locale ?? 'ru';
      const ru = lang === 'ru';
      const message = renderEmail('systemNotice', {
        subject: ru ? 'Проверка отправки почты' : 'Mail delivery test',
        message: ru ? 'Это тестовое письмо. Если вы его читаете, отправка почты из приложения работает.' : 'This is a test letter. If you are reading it, sending mail from the application works.',
      }, { locale: lang, brandName });
      return sendRaw({ from: config.from, replyTo: config.replyTo, to: recipients, subject: message.subject, text: message.text, html: message.html, headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' } }, { scenario: 'test' });
    },
    /** Connectivity/login check for `doctor`: never throws. */
    async verify() {
      if (!enabled) return { ok: false, error: 'disabled' };
      try {
        const t = await getTransport();
        if (typeof t.verify === 'function') await t.verify();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: toEmailError(err).message };
      }
    },
  };
}
