import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, readdirSync } from 'node:fs';

import { acceptUpload, getUploadUsage, assertUploadQuota, findOrphanUploads, removeOrphanUploads, storeUpload } from '../src/files/index.js';

const PNG_LIKE = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]), Buffer.alloc(100, 1)]); // "%PDF-" + padding

describe('upload quota and orphan GC (audit B13)', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'uq-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const put = (size = 100) => storeUpload(Buffer.alloc(size, 7), dir, 'pdf');
  const codeOf = (fn) => {
    try {
      fn();
    } catch (e) {
      return e.code;
    }
    return null;
  };
  const age = (name, ms) => {
    const t = new Date(Date.now() - ms);
    utimesSync(path.join(dir, name), t, t);
  };

  it('usage counts only files of the shape storeUpload generates', () => {
    put(100);
    put(50);
    writeFileSync(path.join(dir, 'notes.txt'), 'x'.repeat(1000));
    writeFileSync(path.join(dir, 'not-a-uuid.pdf'), 'x'.repeat(1000));
    expect(getUploadUsage(dir)).toEqual({ files: 2, bytes: 150 });
    expect(getUploadUsage(path.join(dir, 'missing'))).toEqual({ files: 0, bytes: 0 });
  });

  it('assertUploadQuota enforces bytes and file count, 0/undefined = unlimited', () => {
    put(100);
    expect(() => assertUploadQuota(dir, { maxTotalBytes: 150 }, 40)).not.toThrow();
    expect(codeOf(() => assertUploadQuota(dir, { maxTotalBytes: 150 }, 51))).toBe('QUOTA_EXCEEDED');
    expect(codeOf(() => assertUploadQuota(dir, { maxFiles: 1 }, 1))).toBe('QUOTA_EXCEEDED');
    expect(() => assertUploadQuota(dir, { maxFiles: 2 }, 1)).not.toThrow();
    expect(() => assertUploadQuota(dir, { maxTotalBytes: 0, maxFiles: 0 }, 1e9)).not.toThrow();
    expect(() => assertUploadQuota(dir, undefined, 1e9)).not.toThrow();
  });

  it('acceptUpload refuses with QUOTA_EXCEEDED and writes nothing', async () => {
    const opts = { allowedTypes: ['pdf'], maxBytes: 10_000, storageDir: dir, quota: { maxFiles: 2 } };
    await acceptUpload(PNG_LIKE, opts);
    await acceptUpload(PNG_LIKE, opts);
    const err = await acceptUpload(PNG_LIKE, opts).then(() => null, (e) => e);
    expect(err?.code).toBe('QUOTA_EXCEEDED');
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('findOrphanUploads: unreferenced and old only; referenced and fresh files are safe', () => {
    const kept = put();
    const orphan = put();
    const fresh = put();
    for (const f of [kept, orphan]) age(f.filename, 2 * 3600_000);
    const found = findOrphanUploads(dir, new Set([kept.filename]));
    expect(found.map((o) => o.name)).toEqual([orphan.filename]);
    expect(found.map((o) => o.name)).not.toContain(fresh.filename);
  });

  it('stale .tmp leftovers are collected, fresh ones are not', () => {
    const stale = path.join(dir, '11111111-1111-1111-1111-111111111111.pdf.tmp');
    const fresh = path.join(dir, '22222222-2222-2222-2222-222222222222.pdf.tmp');
    writeFileSync(stale, 'x');
    writeFileSync(fresh, 'x');
    const t = new Date(Date.now() - 3 * 3600_000);
    utimesSync(stale, t, t);
    expect(findOrphanUploads(dir, []).map((o) => o.name)).toEqual([path.basename(stale)]);
  });

  it('removeOrphanUploads deletes them (dryRun only reports) and leaves foreign files alone', () => {
    const orphan = put(10);
    age(orphan.filename, 2 * 3600_000);
    writeFileSync(path.join(dir, 'operator-notes.txt'), 'keep');
    const dry = removeOrphanUploads(dir, [], { dryRun: true });
    expect(dry).toMatchObject({ removed: 1, bytes: 10 });
    expect(existsSync(orphan.fullPath)).toBe(true);
    const real = removeOrphanUploads(dir, []);
    expect(real).toMatchObject({ removed: 1, bytes: 10, names: [orphan.filename] });
    expect(existsSync(orphan.fullPath)).toBe(false);
    expect(existsSync(path.join(dir, 'operator-notes.txt'))).toBe(true);
  });

  it('minAgeMs and now are adjustable', () => {
    const f = put();
    age(f.filename, 10_000); // 10 s old (avoids sub-millisecond clock/mtime races)
    expect(findOrphanUploads(dir, [], { minAgeMs: 5_000 }).map((o) => o.name)).toEqual([f.filename]);
    expect(findOrphanUploads(dir, [], { minAgeMs: 60_000 })).toHaveLength(0);
    expect(findOrphanUploads(dir, [], { minAgeMs: 60_000, now: Date.now() + 120_000 })).toHaveLength(1);
  });
});
