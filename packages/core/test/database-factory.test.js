import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { createDatabase } from '../src/database/index.js';
import { DatabaseConfigSchema } from '../src/config/schema.js';

describe('createDatabase', () => {
  it('opens the SQLite file relative to rootDir (default driver)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'das-dbf-'));
    const db = await createDatabase({ file: 'x.db', walMode: false }, { rootDir: dir });
    db.exec('CREATE TABLE t (a INTEGER)');
    db.run('INSERT INTO t VALUES (?)', [1]);
    expect(db.get('SELECT a FROM t').a).toBe(1);
  });
  it('hands the PostgreSQL settings to the driver, reading the URL from the environment', async () => {
    let seen;
    const importDriver = async () => ({ createPostgresDatabase: async (o) => { seen = o; return { dialect: 'postgres' }; } });
    const db = await createDatabase(
      { driver: 'postgres', url: 'env:DB_URL', poolSize: 4, ssl: true, statementTimeoutMs: 5000 },
      { env: { DB_URL: 'postgres://u:p@h/d' }, importDriver }
    );
    expect(db.dialect).toBe('postgres');
    expect(seen).toEqual({ connectionString: 'postgres://u:p@h/d', max: 4, ssl: { rejectUnauthorized: true }, statementTimeoutMs: 5000 });
  });
  it('explains what is missing: the variable, the package, a literal URL', async () => {
    await expect(createDatabase({ driver: 'postgres', url: 'env:NOPE' }, { env: {} })).rejects.toThrow(/NOPE is not set/);
    await expect(createDatabase({ driver: 'postgres', url: 'env:X' }, { env: { X: 'a' }, importDriver: async () => { throw new Error('nope'); } })).rejects.toThrow(/@das-forge\/db-postgres/);
    await expect(createDatabase({ driver: 'postgres', url: 'postgres://u:secret@h/d' }, { env: {} })).rejects.toThrow(/env:NAME/);
  });
});

describe('database config', () => {
  it('keeps the old defaults and demands url for postgres, as an env reference only', () => {
    expect(DatabaseConfigSchema.parse({}).driver).toBe('node:sqlite');
    expect(DatabaseConfigSchema.safeParse({ driver: 'postgres' }).success).toBe(false);
    expect(DatabaseConfigSchema.safeParse({ driver: 'postgres', url: 'postgres://u:p@h/d' }).success).toBe(false);
    const ok = DatabaseConfigSchema.parse({ driver: 'postgres', url: 'env:DATABASE_URL' });
    expect(ok).toMatchObject({ poolSize: 10, ssl: false });
  });
});
