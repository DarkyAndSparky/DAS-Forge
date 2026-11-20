import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countSyncCalls } from '../../../scripts/sync-db-report.mjs';

const baseline = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/sync-db-baseline.json'), 'utf8'));

describe('synchronous database calls (ADR-0010 ratchet)', () => {
  it('no file has more synchronous calls than the baseline; new code uses asyncDb(db)', () => {
    const now = countSyncCalls();
    const worse = Object.entries(now).filter(([f, n]) => n > (baseline[f] ?? 0)).map(([f, n]) => `${f}: ${baseline[f] ?? 0} -> ${n}`);
    expect(worse, `more synchronous calls than the baseline (run "npm run sync-db"; use asyncDb(db) in new code; after removing calls run "node scripts/sync-db-report.mjs --update"):\n${worse.join('\n')}`).toEqual([]);
  });
  it('counts the receivers db/tx/database and ignores comments and other objects', () => {
    expect(Object.keys(countSyncCalls()).length).toBeGreaterThan(20);
    expect(Object.keys(countSyncCalls()).every((f) => f.startsWith('packages/'))).toBe(true);
  });
});
