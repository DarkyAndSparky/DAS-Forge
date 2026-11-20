import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createManagedUser } from '../src/auth/user-admin.js';
import { createRegistrationStore, ensureRegistrationsTableAsync } from '../src/accounts/registration.js';
import { createDirectoryLinks, ensureDirectoryLinksTableAsync } from '../src/accounts/directory.js';

const fresh = () => createSqliteAdapter({ file: ':memory:', walMode: false });

describe('registration store over the asynchronous database', () => {
  it('adds, cancels the older request of the same address, consumes once, counts, purges', async () => {
    const db = fresh();
    await ensureRegistrationsTableAsync(db);
    let t = Date.parse('2026-01-01T00:00:00Z');
    const reg = createRegistrationStore(db, { now: () => t });
    const first = await reg.addAsync({ username: 'ann', email: 'Ann@X.io', passwordHash: 'h1', ip: '1.1.1.1' });
    const second = await reg.addAsync({ username: 'ann', email: 'ann@x.io', passwordHash: 'h2', ip: '1.1.1.1' });
    expect(await reg.consumeAsync(first)).toBeNull();
    expect(await reg.consumeAsync('short')).toBeNull();
    expect(await reg.recentAsync({ email: 'ANN@x.io', sinceMs: 60_000 })).toBe(2);
    expect(await reg.recentAsync({ ip: '1.1.1.1', sinceMs: 60_000 })).toBe(2);
    expect(reg.recent({ ip: '1.1.1.1', sinceMs: 60_000 })).toBe(2);
    expect(await reg.consumeAsync(second)).toEqual({ username: 'ann', email: 'ann@x.io', passwordHash: 'h2' });
    expect(await reg.consumeAsync(second)).toBeNull();
    t += 3 * 86_400_000;
    expect(await reg.purgeAsync()).toBe(2);
  });
  it('an expired token is refused; the sync consume agrees', async () => {
    const db = fresh();
    await ensureRegistrationsTableAsync(db);
    let t = 1_000_000_000_000;
    const reg = createRegistrationStore(db, { now: () => t });
    const token = await reg.addAsync({ username: 'bob', email: 'bob@x.io', passwordHash: 'h', ttlHours: 1 });
    t += 2 * 3_600_000;
    expect(reg.consume(token)).toBeNull();
    expect(await reg.consumeAsync(token)).toBeNull();
  });
});

describe('directory links over the asynchronous database', () => {
  it('links, relinks, reads; shares rows with the sync methods', async () => {
    const db = fresh();
    ensureAuthTables(db);
    const u = createManagedUser(db, { username: 'ann', email: 'a@x.io', role: 'operator', passwordHash: 'h' });
    await ensureDirectoryLinksTableAsync(db);
    const links = createDirectoryLinks(db);
    expect(await links.getAsync(u.id)).toBeNull();
    await links.linkAsync(u.id, 'ldap', 'uid=ann');
    expect(links.get(u.id)).toEqual({ source: 'ldap', dn: 'uid=ann' });
    await links.linkAsync(u.id, 'ad', null);
    expect(await links.getAsync(u.id)).toEqual({ source: 'ad', dn: null });
  });
});
