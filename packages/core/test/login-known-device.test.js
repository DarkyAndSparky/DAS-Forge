import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { recognizeDevice, hashDevice } from '../src/auth/devices.js';
import { isKnownDeviceAsync } from '../src/auth/async-factors.js';

describe('isKnownDeviceAsync (audit S-03)', () => {
  it('knows only a cookie this user has signed in with, and registers nothing', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    ensureAuthTables(db);
    db.run("INSERT INTO users (username, password_hash, role) VALUES ('ann', 'x', 'admin')");
    const id = db.get("SELECT id FROM users WHERE username = 'ann'").id;
    const { deviceId } = recognizeDevice(db, { userId: id });
    expect(await isKnownDeviceAsync(db, { userId: id, deviceId })).toBe(true);
    expect(await isKnownDeviceAsync(db, { userId: id + 1, deviceId })).toBe(false); // another account
    expect(await isKnownDeviceAsync(db, { userId: id, deviceId: 'A'.repeat(30) })).toBe(false);
    expect(await isKnownDeviceAsync(db, { userId: id, deviceId: null })).toBe(false);
    expect(await isKnownDeviceAsync(db, { userId: id, deviceId: '../bad' })).toBe(false);
    expect(Number(db.get('SELECT COUNT(*) AS n FROM login_devices').n)).toBe(1);
    expect(hashDevice(deviceId)).toHaveLength(64);
  });
});
