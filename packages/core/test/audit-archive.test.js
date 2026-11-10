import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createSqliteAdapter } from '../src/database/index.js';
import { log, query, verifyChain, archiveBefore, verifyArchive, archiveAndPurge } from '../src/audit/index.js';
import { securityChecks } from '../src/health/checks/security.js';

function seeded(n = 5) {
  const db = createSqliteAdapter({ file: ':memory:' });
  for (let i = 0; i < n; i += 1) log(db, { actor: `u${i}`, action: 'auth.login' });
  return db;
}
const future = () => new Date(Date.now() + 60_000).toISOString();

describe('audit archive before retention (stage E, R-14)', () => {
  it('writes every row with its hashes, a trailer and a checksum that verifies', async () => {
    const db = seeded(5);
    const dir = mkdtempSync(join(tmpdir(), 'audit-arch-'));
    const a = await archiveBefore(db, future(), { dir });
    expect(a.rows).toBe(5);
    expect(a.file.endsWith('.ndjson.gz')).toBe(true);
    const lines = gunzipSync(readFileSync(a.file)).toString().trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(6);
    expect(lines[0].hash).toBeTruthy();
    expect(lines[5]).toMatchObject({ trailer: true, rows: 5, lastId: a.lastId, lastHash: a.lastHash });
    expect(verifyArchive(a.file)).toMatchObject({ ok: true, rows: 5 });
  });
  it('detects a tampered archive', async () => {
    const db = seeded(3);
    const dir = mkdtempSync(join(tmpdir(), 'audit-arch-'));
    const a = await archiveBefore(db, future(), { dir });
    writeFileSync(`${a.file}.sha256`, `${'0'.repeat(64)}  x\n`);
    expect(verifyArchive(a.file)).toMatchObject({ ok: false, reason: 'checksum does not match' });
    expect(verifyArchive(join(dir, 'missing.gz')).ok).toBe(false);
  });
  it('archives, then deletes; the chain of what is left stays valid; the purge entry names the archive', async () => {
    const db = seeded(4);
    const dir = mkdtempSync(join(tmpdir(), 'audit-arch-'));
    const r = await archiveAndPurge(db, future(), { archiveDir: dir, actor: 'system' });
    expect(r.removed).toBe(4);
    expect(readdirSync(dir).sort()).toHaveLength(2); // the archive and its checksum
    const purge = query(db, { action: 'audit.purge' })[0];
    expect(purge.meta.archive).toMatchObject({ rows: 4, sha256: r.archive.sha256 });
    expect(verifyChain(db).ok).toBe(true);
  });
  it('nothing to archive: no file, nothing fails', async () => {
    const db = seeded(2);
    const dir = mkdtempSync(join(tmpdir(), 'audit-arch-'));
    expect(await archiveBefore(db, '2000-01-01T00:00:00Z', { dir })).toBeNull();
    expect(readdirSync(dir)).toHaveLength(0);
  });
  it('the doctor warns in production when rows are deleted without an archive or a full mirror', () => {
    const base = { env: 'production', auth: { sessionSecret: 'x'.repeat(40) }, audit: { retentionDays: 365, archiveDir: '' }, logging: { auditMirror: 'minimal' } };
    const find = (cfg) => securityChecks(cfg).find((c) => c.name === 'Audit archive');
    expect(find(base)?.status).toBe('warn');
    expect(find({ ...base, audit: { ...base.audit, archiveDir: '/var/audit' } })).toBeUndefined();
    expect(find({ ...base, logging: { auditMirror: 'full' } })).toBeUndefined();
  });
});
