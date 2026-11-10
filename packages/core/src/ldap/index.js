import { z } from 'zod';

/**
 * LDAP / Active Directory sign-in (search + bind) on the `ldapts` package, loaded on demand.
 * Written from what it-assets and net-monitor do today, with the differences resolved the strict way:
 *   - an EMPTY password is refused before any LDAP call (an empty-password bind is an anonymous bind and
 *     succeeds - net-monitor's version did not guard this);
 *   - 0 or >1 search matches = refusal (net-monitor took the first match);
 *   - the username goes into the filter escaped (RFC 4515, `Filter.escape` of ldapts);
 *   - TLS is verified; turning that off needs the explicit `insecureTls: true` and is never the default;
 *   - the connection must be encrypted (ldaps:// or startTls); plain ldap:// needs `allowPlaintext: true`;
 *   - the service password is an `env:NAME` reference in config files;
 *   - "server unreachable" and "wrong password" are different `code`s for the log, the app should show the
 *     user ONE message for both.
 * The app keeps its own user table: authenticate() returns who the directory says this is (DN, name, mail,
 * groups, mapped role); creating/finding the local account is the app's decision.
 */
const EnvRef = z.string().regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/, 'must be an env:NAME reference, not the secret itself');

export const LdapConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  url: z.string().regex(/^ldaps?:\/\/[^\s/]+(:\d+)?$/, 'ldap://host[:port] or ldaps://host[:port]'),
  startTls: z.boolean().default(false),
  bindDn: z.string().min(1),
  bindPassword: EnvRef,
  baseDn: z.string().min(1),
  userFilter: z.string().default('(uid={{username}})').refine((f) => f.split('{{username}}').length === 2 && f.startsWith('(') && f.endsWith(')'), 'must be a parenthesised filter containing {{username}} exactly once'),
  attributes: z.strictObject({
    displayName: z.string().default('displayName'),
    mail: z.string().default('mail'),
    groups: z.string().default('memberOf'),
  }).default({ displayName: 'displayName', mail: 'mail', groups: 'memberOf' }),
  roleMapping: z.array(z.strictObject({ group: z.string().min(1), role: z.string().min(1) })).default([]),
  defaultRole: z.string().min(1).default('viewer'),
  tlsCaFile: z.string().min(1).optional(),
  insecureTls: z.boolean().default(false),
  // Plain ldap:// without STARTTLS sends the service password and every user's password in clear text.
  allowPlaintext: z.boolean().default(false),
  connectTimeoutMs: z.number().int().positive().default(5000),
  timeoutMs: z.number().int().positive().default(8000),
}).refine((c) => c.url.startsWith('ldaps://') || c.startTls || c.allowPlaintext, {
  path: ['url'],
  message: 'ldap:// without startTls sends passwords in clear text: use ldaps://, set startTls: true, or (a lab only) allowPlaintext: true',
});

async function loadLdapts() {
  try {
    return await import('ldapts');
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') throw new Error('LDAP sign-in needs the "ldapts" package (npm install ldapts)');
    throw err;
  }
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const first = (v) => asArray(v).map(String)[0] ?? null;

/** First matching rule wins (list order = priority); group DNs compare case-insensitively. */
export function roleFromGroups(groups, roleMapping = [], defaultRole = 'viewer') {
  const have = new Set(asArray(groups).map((g) => String(g).toLowerCase()));
  for (const rule of roleMapping) if (have.has(rule.group.toLowerCase())) return rule.role;
  return defaultRole;
}

/**
 * @param {object} rawConfig - LdapConfigSchema shape
 * @param {object} [o]
 * @param {object} [o.env=process.env] - where `env:NAME` is resolved
 * @param {string} [o.bindPassword] - literal service password (apps that keep settings in their own store)
 * @param {object} [o.ldapts] - injected module (tests); default: the real package, loaded on demand
 * @param {(f:string)=>string} [o.readFile] - reads tlsCaFile
 */
export function createLdapAuthenticator(rawConfig, { env = process.env, bindPassword = null, ldapts = null, readFile = null } = {}) {
  const cfg = LdapConfigSchema.parse(rawConfig);
  let mod = ldapts;
  const close = (c) => c.unbind().catch(() => {});

  function secret() {
    if (bindPassword) return bindPassword;
    const v = env[cfg.bindPassword.slice(4)];
    if (!v) throw new Error(`LDAP: environment variable ${cfg.bindPassword.slice(4)} is not set`);
    return v;
  }

  async function newClient() {
    mod ??= await loadLdapts();
    const tlsOptions = {};
    if (cfg.insecureTls) tlsOptions.rejectUnauthorized = false;
    if (cfg.tlsCaFile) {
      const { readFileSync } = await import('node:fs');
      tlsOptions.ca = (readFile ?? ((f) => readFileSync(f, 'utf8')))(cfg.tlsCaFile);
    }
    const client = new mod.Client({ url: cfg.url, connectTimeout: cfg.connectTimeoutMs, timeout: cfg.timeoutMs, ...(Object.keys(tlsOptions).length ? { tlsOptions } : {}) });
    if (cfg.startTls && cfg.url.startsWith('ldap://')) {
      try {
        await client.startTLS(tlsOptions);
      } catch (e) {
        await close(client); // do not leave the half-open socket behind
        throw e;
      }
    }
    return client;
  }


  /**
   * @returns {Promise<{ok:true, dn:string, username:string, displayName:string, email:string|null, groups:string[], role:string}
   *   | {ok:false, code:'DISABLED'|'INVALID_INPUT'|'NOT_FOUND'|'AMBIGUOUS'|'BAD_PASSWORD'|'UNAVAILABLE', error?:string}>}
   */
  async function authenticate(username, password) {
    if (!cfg.enabled) return { ok: false, code: 'DISABLED' };
    if (typeof username !== 'string' || typeof password !== 'string' || username.trim() === '' || password === '' || username.length > 256 || password.length > 1024 || username.includes('\0')) {
      return { ok: false, code: 'INVALID_INPUT' };
    }
    let entry;
    const service = await newClient().catch((e) => ({ failed: e }));
    if (service.failed) return { ok: false, code: 'UNAVAILABLE', error: service.failed.message };
    try {
      await service.bind(cfg.bindDn, secret());
      // a function, not a string: `$&`, `$'` in a user name would otherwise be read as replacement patterns
      const escaped = mod.Filter.escape(username.trim());
      const filter = cfg.userFilter.replace('{{username}}', () => escaped);
      const { searchEntries } = await service.search(cfg.baseDn, {
        scope: 'sub', filter, attributes: ['dn', cfg.attributes.displayName, 'cn', cfg.attributes.mail, cfg.attributes.groups], sizeLimit: 2,
      });
      if (searchEntries.length === 0) return { ok: false, code: 'NOT_FOUND' };
      if (searchEntries.length > 1) return { ok: false, code: 'AMBIGUOUS' };
      entry = searchEntries[0];
    } catch (e) {
      // the directory stopped at sizeLimit 2: more than one entry matched
      if (/SizeLimitExceeded/i.test(`${e?.name} ${e?.constructor?.name}`) || e?.code === 4) return { ok: false, code: 'AMBIGUOUS' };
      return { ok: false, code: 'UNAVAILABLE', error: e.message };
    } finally {
      await close(service);
    }

    const userClient = await newClient().catch((e) => ({ failed: e }));
    if (userClient.failed) return { ok: false, code: 'UNAVAILABLE', error: userClient.failed.message };
    try {
      await userClient.bind(entry.dn, password);
    } catch (e) {
      // ldapts raises InvalidCredentialsError for a wrong password; everything else is a connection problem
      return /InvalidCredentials/i.test(`${e?.name} ${e?.constructor?.name}`) || e?.code === 49
        ? { ok: false, code: 'BAD_PASSWORD' }
        : { ok: false, code: 'UNAVAILABLE', error: e.message };
    } finally {
      await close(userClient);
    }

    const groups = asArray(entry[cfg.attributes.groups]).map(String);
    return {
      ok: true,
      dn: entry.dn,
      username: username.trim(),
      displayName: first(entry[cfg.attributes.displayName]) ?? first(entry.cn) ?? username.trim(),
      email: first(entry[cfg.attributes.mail]),
      groups,
      role: roleFromGroups(groups, cfg.roleMapping, cfg.defaultRole),
    };
  }

  /** Service-account bind (and, with `checkSearch`, a one-entry search under baseDn) - for a "Test connection" button. */
  async function testConnection({ checkSearch = true } = {}) {
    let client;
    try {
      client = await newClient();
      await client.bind(cfg.bindDn, secret());
      if (checkSearch) await client.search(cfg.baseDn, { scope: 'base', filter: '(objectClass=*)', sizeLimit: 1 });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      if (client) await close(client);
    }
  }

  return { authenticate, testConnection, config: cfg };
}
