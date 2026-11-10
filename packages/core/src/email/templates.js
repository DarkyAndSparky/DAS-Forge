import { pickTexts } from '../i18n/overrides.js';
/**
 * The system e-mails every app sends, as NAMED scenarios with a fixed set of
 * required fields (roadmap §4.5e): an app supplies data, never free-form HTML,
 * so "password reset" reads and behaves the same in all four apps.
 *
 * Everything that reaches the HTML is escaped; links must be http(s); values
 * that end up in the Subject cannot contain line breaks (header injection).
 * Each scenario has Russian and English text.
 */

const SEVERITIES = ['info', 'warning', 'critical'];

export const SCENARIOS = {
  alert: { fields: { title: 'text', message: 'text', severity: 'severity' } },
  passwordReset: { fields: { resetUrl: 'url', expiresInMinutes: 'number' } },
  passwordChanged: { fields: {} },
  emailVerification: { fields: { verifyUrl: 'url' } },
  accountBanned: { fields: { reason: 'text', until: 'optionalText' } },
  accountUnbanned: { fields: {} },
  newDeviceLogin: { fields: { when: 'line', ip: 'line', device: 'line' } },
  userInvited: { fields: { inviteUrl: 'url', invitedBy: 'text' } },
  systemNotice: { fields: { subject: 'line', message: 'text' } },
};

const TEXT = {
  ru: {
    alert: (d) => ({ subject: `[${d.severity.toUpperCase()}] ${oneLine(d.title)}`, lead: d.title, body: d.message }),
    passwordReset: (d) => ({
      subject: 'Сброс пароля',
      lead: 'Вы запросили сброс пароля.',
      body: `Ссылка действует ${d.expiresInMinutes} мин. Если это были не вы, просто проигнорируйте письмо.`,
      link: [d.resetUrl, 'Задать новый пароль'],
    }),
    passwordChanged: () => ({
      subject: 'Пароль изменён',
      lead: 'Пароль вашей учётной записи был изменён.',
      body: 'Если это были не вы, немедленно обратитесь к администратору.',
    }),
    emailVerification: (d) => ({ subject: 'Подтверждение e-mail', lead: 'Подтвердите адрес электронной почты.', link: [d.verifyUrl, 'Подтвердить адрес'] }),
    accountBanned: (d) => ({
      subject: 'Учётная запись заблокирована',
      lead: 'Ваша учётная запись заблокирована.',
      body: `Причина: ${d.reason}.${d.until ? ` Блокировка действует до ${d.until}.` : ''}`,
    }),
    newDeviceLogin: (d) => ({
      subject: 'Вход с нового устройства',
      lead: 'В вашу учётную запись вошли с устройства, которого раньше не было.',
      body: `Когда: ${d.when}. Адрес: ${d.ip}. Устройство: ${d.device}. Если это были вы, ничего делать не нужно. Если нет, смените пароль и сообщите администратору.`,
    }),
    accountUnbanned: () => ({ subject: 'Учётная запись разблокирована', lead: 'Блокировка вашей учётной записи снята.' }),
    userInvited: (d) => ({
      subject: 'Приглашение в систему',
      lead: `${d.invitedBy} приглашает вас в систему.`,
      link: [d.inviteUrl, 'Принять приглашение'],
    }),
    systemNotice: (d) => ({ subject: oneLine(d.subject), lead: d.subject, body: d.message }),
  },
  en: {
    alert: (d) => ({ subject: `[${d.severity.toUpperCase()}] ${oneLine(d.title)}`, lead: d.title, body: d.message }),
    passwordReset: (d) => ({
      subject: 'Password reset',
      lead: 'You asked to reset your password.',
      body: `The link is valid for ${d.expiresInMinutes} minutes. If this was not you, ignore this message.`,
      link: [d.resetUrl, 'Choose a new password'],
    }),
    passwordChanged: () => ({
      subject: 'Your password was changed',
      lead: 'The password of your account was changed.',
      body: 'If this was not you, contact an administrator immediately.',
    }),
    emailVerification: (d) => ({ subject: 'Confirm your e-mail', lead: 'Please confirm your e-mail address.', link: [d.verifyUrl, 'Confirm address'] }),
    accountBanned: (d) => ({
      subject: 'Your account was blocked',
      lead: 'Your account has been blocked.',
      body: `Reason: ${d.reason}.${d.until ? ` The block lasts until ${d.until}.` : ''}`,
    }),
    newDeviceLogin: (d) => ({
      subject: 'Sign-in from a new device',
      lead: 'Your account was signed in to from a device not seen before.',
      body: `When: ${d.when}. Address: ${d.ip}. Device: ${d.device}. If this was you, no action is needed. If not, change your password and tell an administrator.`,
    }),
    accountUnbanned: () => ({ subject: 'Your account was unblocked', lead: 'The block on your account has been lifted.' }),
    userInvited: (d) => ({
      subject: 'You are invited',
      lead: `${d.invitedBy} invites you to the system.`,
      link: [d.inviteUrl, 'Accept the invitation'],
    }),
    systemNotice: (d) => ({ subject: oneLine(d.subject), lead: d.subject, body: d.message }),
  },
};

function oneLine(s) {
  return String(s).replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function validate(scenario, data) {
  const def = SCENARIOS[scenario];
  if (!def) throw new TypeError(`Unknown e-mail scenario "${scenario}"`);
  const clean = {};
  const problems = [];
  for (const [name, kind] of Object.entries(def.fields)) {
    const v = data?.[name];
    const missing = v === undefined || v === null || v === '';
    if (kind === 'optionalText') {
      if (!missing) clean[name] = String(v).slice(0, 200);
      continue;
    }
    if (missing) {
      problems.push(`${name} is required`);
      continue;
    }
    if (kind === 'url') {
      let u;
      try {
        u = new URL(String(v));
      } catch {
        problems.push(`${name} is not a valid URL`);
        continue;
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') problems.push(`${name} must be an http(s) URL`);
      else clean[name] = u.href;
    } else if (kind === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) problems.push(`${name} must be a positive number`);
      else clean[name] = Math.round(n);
    } else if (kind === 'severity') {
      if (!SEVERITIES.includes(v)) problems.push(`${name} must be one of ${SEVERITIES.join(', ')}`);
      else clean[name] = v;
    } else if (kind === 'line') {
      clean[name] = oneLine(v).slice(0, 200);
    } else {
      clean[name] = String(v).slice(0, 5000);
    }
  }
  if (problems.length) throw new TypeError(`E-mail "${scenario}": ${problems.join('; ')}`);
  return clean;
}

const SEVERITY_COLOR = { info: '#2563eb', warning: '#d97706', critical: '#dc2626' };

/**
 * @param {string} scenario
 * @param {object} data - the scenario's fields
 * @param {{locale?: 'ru'|'en', brandName?: string}} [opts]
 * @returns {{subject: string, text: string, html: string}}
 */
export function renderEmail(scenario, data, { locale = 'ru', brandName = 'DAS-Forge' } = {}) {
  const clean = validate(scenario, data);
  const lang = TEXT[locale] ? locale : 'ru';
  const part = pickTexts(TEXT, undefined, lang, 'email')[scenario](clean);
  const accent = scenario === 'alert' ? SEVERITY_COLOR[clean.severity] : '#2563eb';

  const text = [part.lead, part.body, part.link ? `${part.link[1]}: ${part.link[0]}` : null, `-- ${brandName}`].filter(Boolean).join('\n\n');
  const html = `<!doctype html><html lang="${lang}"><body style="margin:0;padding:24px;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-top:4px solid ${accent};padding:24px">
<h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(part.lead)}</h2>
${part.body ? `<p style="margin:0 0 16px;line-height:1.5;white-space:pre-wrap">${escapeHtml(part.body)}</p>` : ''}
${part.link ? `<p style="margin:0 0 16px"><a href="${escapeHtml(part.link[0])}" style="display:inline-block;padding:10px 18px;background:${accent};color:#ffffff;text-decoration:none;border-radius:4px">${escapeHtml(part.link[1])}</a></p><p style="margin:0 0 16px;font-size:12px;color:#6b7280;word-break:break-all">${escapeHtml(part.link[0])}</p>` : ''}
<p style="margin:24px 0 0;font-size:12px;color:#6b7280">${escapeHtml(brandName)}</p>
</div></body></html>`;
  return { subject: oneLine(part.subject).slice(0, 200), text, html };
}

export { TEXT as EMAIL_TEXTS };
