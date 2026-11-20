import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { databaseChecks, databaseChecksAsync } from '../src/health/index.js';

const fresh = () => createSqliteAdapter({ file: ':memory:', walMode: false });

describe('database diagnostics over the asynchronous database', () => {
  it('gives the same checks as the synchronous version', async () => {
    const db = fresh();
    expect(await databaseChecksAsync(db)).toEqual(databaseChecks(db));
  });
  it('reports a dead connection and stops', async () => {
    const dead = { get() { throw new Error('down'); }, all() { throw new Error('down'); }, run() {}, exec() {} };
    const r = await databaseChecksAsync(dead);
    expect(r.length).toBe(1);
    expect(r[0].status).toBe('fail');
  });
  it('skips the SQLite integrity check on another dialect and awaits an async migration status', async () => {
    const pg = { dialect: 'postgres', get: async () => ({ ok: 1 }), all: async () => [], run: async () => ({}), exec: async () => {}, transaction: async (f) => f(pg) };
    const r = await databaseChecksAsync(pg, { migrationsDir: 'x', migrationStatusFn: async () => [{ applied: true }, { applied: false }] });
    expect(r.map((c) => c.name)).toEqual(['Connection', 'Integrity', 'Migrations']);
    expect(r[1].message).toContain('postgres');
    expect(r[2].status).toBe('fail');
  });
});
