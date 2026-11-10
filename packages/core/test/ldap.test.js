import { describe, it, expect } from 'vitest';
import { createLdapAuthenticator, roleFromGroups, LdapConfigSchema } from '../src/ldap/index.js';

class InvalidCredentialsError extends Error {}

function fakeLdapts({ users, serviceDn = 'cn=svc', servicePw = 'svcpw', down = false } = {}) {
  const log = { clients: [], searches: [], binds: [], startTls: 0 };
  class Client {
    constructor(opts) { this.opts = opts; log.clients.push(opts); }
    async startTLS() { log.startTls++; }
    async bind(dn, pw) {
      log.binds.push([dn, pw]);
      if (down) throw new Error('connect ECONNREFUSED');
      if (dn === serviceDn && pw === servicePw) return;
      const u = users.find((x) => x.dn === dn);
      if (u && pw !== '' && u.pw === pw) return;
      throw new InvalidCredentialsError('bad');
    }
    async search(base, opts) {
      log.searches.push({ base, ...opts });
      const m = /uid=(.*)\)$/.exec(opts.filter);
      const uid = m ? m[1] : null;
      return { searchEntries: users.filter((u) => u.uid === uid) };
    }
    async unbind() {}
  }
  const Filter = { escape: (v) => String(v).replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`) };
  return { mod: { Client, Filter }, log };
}

const BASE = { url: 'ldaps://dc.example.com', bindDn: 'cn=svc', bindPassword: 'env:LDAP_PW', baseDn: 'dc=example,dc=com' };
const ENV = { LDAP_PW: 'svcpw' };
const USERS = [
  { dn: 'uid=ann,dc=example,dc=com', uid: 'ann', pw: 'secret', displayName: 'Ann A', mail: 'ann@example.com', memberOf: ['CN=Admins,DC=example,DC=com', 'CN=Other'] },
  { dn: 'uid=dup1,dc=example,dc=com', uid: 'dup', pw: 'x' },
  { dn: 'uid=dup2,dc=example,dc=com', uid: 'dup', pw: 'x' },
];

describe('core/ldap', () => {
  it('signs a user in and maps groups to a role', async () => {
    const { mod } = fakeLdapts({ users: USERS });
    const a = createLdapAuthenticator({ ...BASE, roleMapping: [{ group: 'cn=admins,dc=example,dc=com', role: 'admin' }] }, { env: ENV, ldapts: mod });
    const r = await a.authenticate('ann', 'secret');
    expect(r).toMatchObject({ ok: true, dn: 'uid=ann,dc=example,dc=com', displayName: 'Ann A', email: 'ann@example.com', role: 'admin' });
    expect(r.groups.length).toBe(2);
  });

  it('refuses an empty password before touching the directory', async () => {
    const { mod, log } = fakeLdapts({ users: USERS });
    const a = createLdapAuthenticator(BASE, { env: ENV, ldapts: mod });
    expect((await a.authenticate('ann', '')).code).toBe('INVALID_INPUT');
    expect((await a.authenticate('', 'x')).code).toBe('INVALID_INPUT');
    expect((await a.authenticate('ann\0', 'x')).code).toBe('INVALID_INPUT');
    expect(log.clients.length).toBe(0);
  });

  it('escapes the username in the filter (no LDAP injection)', async () => {
    const { mod, log } = fakeLdapts({ users: USERS });
    const a = createLdapAuthenticator(BASE, { env: ENV, ldapts: mod });
    await a.authenticate('*)(uid=*', 'x');
    expect(log.searches[0].filter).toBe('(uid=\\2a\\29\\28uid=\\2a)');
  });

  it('fails closed on no match, several matches, wrong password, unreachable server', async () => {
    const { mod } = fakeLdapts({ users: USERS });
    const a = createLdapAuthenticator(BASE, { env: ENV, ldapts: mod });
    expect((await a.authenticate('nobody', 'x')).code).toBe('NOT_FOUND');
    expect((await a.authenticate('dup', 'x')).code).toBe('AMBIGUOUS');
    expect((await a.authenticate('ann', 'wrong')).code).toBe('BAD_PASSWORD');
    const down = fakeLdapts({ users: USERS, down: true });
    const b = createLdapAuthenticator(BASE, { env: ENV, ldapts: down.mod });
    expect((await b.authenticate('ann', 'secret')).code).toBe('UNAVAILABLE');
  });

  it('TLS: verified by default, relaxed only on explicit flag, StartTLS and CA supported', async () => {
    const s1 = fakeLdapts({ users: USERS });
    await createLdapAuthenticator(BASE, { env: ENV, ldapts: s1.mod }).authenticate('ann', 'secret');
    expect(s1.log.clients[0].tlsOptions).toBe(undefined);
    const s2 = fakeLdapts({ users: USERS });
    await createLdapAuthenticator({ ...BASE, insecureTls: true }, { env: ENV, ldapts: s2.mod }).authenticate('ann', 'secret');
    expect(s2.log.clients[0].tlsOptions.rejectUnauthorized).toBe(false);
    const s3 = fakeLdapts({ users: USERS });
    await createLdapAuthenticator({ ...BASE, url: 'ldap://dc.example.com', startTls: true, tlsCaFile: '/ca.pem' }, { env: ENV, ldapts: s3.mod, readFile: () => 'PEM' }).authenticate('ann', 'secret');
    expect(s3.log.startTls).toBe(2);
    expect(s3.log.clients[0].tlsOptions.ca).toBe('PEM');
  });

  it('config: secret must be env:NAME, filter must contain {{username}} once, literal override allowed in code', async () => {
    expect(() => LdapConfigSchema.parse({ ...BASE, bindPassword: 'plain' })).toThrow(/env:NAME/);
    expect(() => LdapConfigSchema.parse({ ...BASE, userFilter: '(uid=fixed)' })).toThrow(/username/);
    expect(() => LdapConfigSchema.parse({ ...BASE, url: 'http://x' })).toThrow(/ldap/);
    const { mod } = fakeLdapts({ users: USERS });
    const a = createLdapAuthenticator(BASE, { env: {}, bindPassword: 'svcpw', ldapts: mod });
    expect((await a.authenticate('ann', 'secret')).ok).toBe(true);
    const missing = createLdapAuthenticator(BASE, { env: {}, ldapts: mod });
    expect((await missing.authenticate('ann', 'secret')).code).toBe('UNAVAILABLE');
  });

  it('testConnection binds the service account', async () => {
    const { mod } = fakeLdapts({ users: USERS });
    expect((await createLdapAuthenticator(BASE, { env: ENV, ldapts: mod }).testConnection()).ok).toBe(true);
    const bad = await createLdapAuthenticator(BASE, { env: { LDAP_PW: 'nope' }, ldapts: mod }).testConnection();
    expect(bad.ok).toBe(false);
  });

  it('roleFromGroups: first rule in list order wins, default otherwise', () => {
    const map = [{ group: 'CN=A', role: 'admin' }, { group: 'CN=B', role: 'operator' }];
    expect(roleFromGroups(['cn=b', 'cn=a'], map, 'viewer')).toBe('admin');
    expect(roleFromGroups('CN=B', map, 'viewer')).toBe('operator');
    expect(roleFromGroups([], map, 'viewer')).toBe('viewer');
  });
});

describe('core/ldap hardening (audit of 0.1.95)', () => {
  it('refuses plain ldap:// unless startTls or allowPlaintext is set', () => {
    expect(() => LdapConfigSchema.parse({ ...BASE, url: 'ldap://dc.example.com' })).toThrow(/clear text/);
    expect(LdapConfigSchema.parse({ ...BASE, url: 'ldap://dc.example.com', startTls: true }).startTls).toBe(true);
    expect(LdapConfigSchema.parse({ ...BASE, url: 'ldap://dc.example.com', allowPlaintext: true }).allowPlaintext).toBe(true);
    expect(LdapConfigSchema.parse(BASE).url).toBe('ldaps://dc.example.com');
  });

  it('a user name with replacement patterns ($&, $\') cannot reshape the filter', async () => {
    const { mod, log } = fakeLdapts({ users: USERS });
    const a = createLdapAuthenticator({ ...BASE, userFilter: '(&(objectClass=person)(uid={{username}}))' }, { env: ENV, ldapts: mod });
    await a.authenticate("$'x$&", 'x');
    expect(log.searches[0].filter).toBe("(&(objectClass=person)(uid=$'x$&))");
  });

  it('a directory that stops at the size limit means AMBIGUOUS, not UNAVAILABLE', async () => {
    class SizeLimitExceededError extends Error {}
    const { mod } = fakeLdapts({ users: USERS });
    const Base = mod.Client;
    mod.Client = class extends Base { async search() { throw new SizeLimitExceededError('limit'); } };
    const a = createLdapAuthenticator(BASE, { env: ENV, ldapts: mod });
    expect((await a.authenticate('dup', 'x')).code).toBe('AMBIGUOUS');
  });
});
