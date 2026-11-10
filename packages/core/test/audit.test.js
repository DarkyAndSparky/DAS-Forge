import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createSqliteAdapter } from '../src/database/index.js';
import { log, tail, query, count, purgeOlderThan, contextFromRequest } from '../src/audit/index.js';

describe('audit.log / tail / query', () => {
  let db;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
  });

  afterEach(() => {
    db.close();
  });

  it('requires an action', () => {
    expect(() => log(db, {})).toThrow(/action/);
  });

  it('rejects an invalid result value', () => {
    expect(() => log(db, { action: 'x', result: 'maybe' })).toThrow(/result/);
  });

  it('logs an entry with defaults for omitted fields', () => {
    const entry = log(db, { action: 'auth.login' });
    expect(entry.id).toBeTypeOf('number');
    expect(entry.actor).toBeNull();
    expect(entry.action).toBe('auth.login');
    expect(entry.entity).toBeNull();
    expect(entry.entityId).toBeNull();
    expect(entry.result).toBe('success');
    expect(entry.meta).toEqual({});
    expect(entry.createdAt).toBeTypeOf('string');
  });

  it('logs a full entry and round-trips entityId/meta correctly', () => {
    const entry = log(db, {
      actor: 'jdoe',
      action: 'asset.dispose',
      entity: 'asset',
      entityId: 42,
      result: 'failure',
      meta: { reason: 'no permission' },
      requestId: 'req-123',
      ip: '10.0.0.1',
    });

    expect(entry.actor).toBe('jdoe');
    expect(entry.entity).toBe('asset');
    // entityId is stored as TEXT (column must hold string or numeric
    // entity ids uniformly) but round-trips as the string form.
    expect(entry.entityId).toBe('42');
    expect(entry.result).toBe('failure');
    expect(entry.meta).toEqual({ reason: 'no permission' });
    expect(entry.requestId).toBe('req-123');
    expect(entry.ip).toBe('10.0.0.1');
  });

  it('tail returns most recent entries first, respecting limit', () => {
    log(db, { action: 'a1' });
    log(db, { action: 'a2' });
    log(db, { action: 'a3' });

    const last2 = tail(db, { limit: 2 });
    expect(last2).toHaveLength(2);
    expect(last2[0].action).toBe('a3');
    expect(last2[1].action).toBe('a2');
  });

  it('query filters by actor/action/entity/result independently and together', () => {
    log(db, { actor: 'alice', action: 'auth.login', result: 'success' });
    log(db, { actor: 'alice', action: 'auth.login', result: 'failure' });
    log(db, { actor: 'bob', action: 'auth.login', result: 'success' });
    log(db, { actor: 'alice', action: 'asset.dispose', entity: 'asset', entityId: 7 });

    expect(query(db, { actor: 'alice' })).toHaveLength(3);
    expect(query(db, { action: 'auth.login' })).toHaveLength(3);
    expect(query(db, { result: 'failure' })).toHaveLength(1);
    expect(query(db, { entity: 'asset', entityId: 7 })).toHaveLength(1);
    expect(query(db, { actor: 'alice', action: 'auth.login', result: 'failure' })).toHaveLength(1);
    expect(query(db, { actor: 'carol' })).toHaveLength(0);
  });

  it('query supports since/until date-range filtering', () => {
    // log() first - it's what calls ensureAuditTable(), so audit_log
    // exists before the raw INSERT below touches it directly. A bare
    // db.run('INSERT INTO audit_log ...') as the very first operation
    // on a fresh :memory: db fails with "no such table: audit_log".
    log(db, { action: 'recent.event' });
    db.run(
      `INSERT INTO audit_log (action, result, meta, created_at) VALUES (?, 'success', '{}', ?)`,
      ['old.event', '2020-01-01T00:00:00.000Z']
    );

    const recentOnly = query(db, { since: '2025-01-01T00:00:00.000Z' });
    expect(recentOnly).toHaveLength(1);
    expect(recentOnly[0].action).toBe('recent.event');

    const oldOnly = query(db, { until: '2020-12-31T23:59:59.000Z' });
    expect(oldOnly).toHaveLength(1);
    expect(oldOnly[0].action).toBe('old.event');
  });

  it('query paginates with limit/offset', () => {
    for (let i = 0; i < 5; i++) log(db, { action: `evt.${i}` });

    const page1 = query(db, { limit: 2, offset: 0 });
    const page2 = query(db, { limit: 2, offset: 2 });
    expect(page1.map((e) => e.action)).toEqual(['evt.4', 'evt.3']);
    expect(page2.map((e) => e.action)).toEqual(['evt.2', 'evt.1']);
  });

  it('count matches the same filters as query, ignoring limit/offset', () => {
    log(db, { actor: 'alice', action: 'x' });
    log(db, { actor: 'alice', action: 'x' });
    log(db, { actor: 'bob', action: 'x' });

    expect(count(db, { actor: 'alice' })).toBe(2);
    expect(count(db, {})).toBe(3);
  });

  it('rejects unsafe usage the same way regardless of call order (table auto-created)', () => {
    // ensureAuditTable() runs lazily on first call - this just proves
    // tail()/query()/count() work even if log() was never called first.
    expect(tail(db)).toEqual([]);
    expect(query(db)).toEqual([]);
    expect(count(db)).toBe(0);
  });
});

describe('audit.purgeOlderThan', () => {
  let db;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
  });

  afterEach(() => {
    db.close();
  });

  it('requires a cutoff', () => {
    expect(() => purgeOlderThan(db, undefined)).toThrow();
  });

  it('deletes only rows strictly older than the cutoff and returns the count removed', () => {
    // Same ordering fix as above: log() first to create audit_log via
    // ensureAuditTable(), then the raw inserts.
    log(db, { action: 'recent' });
    db.run(`INSERT INTO audit_log (action, result, meta, created_at) VALUES ('a', 'success', '{}', ?)`, [
      '2020-01-01T00:00:00.000Z',
    ]);
    db.run(`INSERT INTO audit_log (action, result, meta, created_at) VALUES ('b', 'success', '{}', ?)`, [
      '2020-06-01T00:00:00.000Z',
    ]);

    const removed = purgeOlderThan(db, '2021-01-01T00:00:00.000Z');
    expect(removed).toBe(2);
    expect(tail(db).map((e) => e.action)).toEqual(['recent']);
  });
});

describe('audit.contextFromRequest', () => {
  it('reads actor/requestId/ip from an authenticated request', () => {
    const req = { id: 'req-9', ip: '127.0.0.1', user: { username: 'jdoe' } };
    expect(contextFromRequest(req)).toEqual({ actor: 'jdoe', requestId: 'req-9', ip: '127.0.0.1' });
  });

  it('defaults actor to null for an anonymous request', () => {
    const req = { id: 'req-9', ip: '127.0.0.1' };
    expect(contextFromRequest(req)).toEqual({ actor: null, requestId: 'req-9', ip: '127.0.0.1' });
  });

  it('tolerates a missing/undefined req entirely', () => {
    expect(contextFromRequest(undefined)).toEqual({ actor: null, requestId: null, ip: null });
  });
});

describe('logSpreadsheetImport', () => {
  it('records the counts and codes of an import, never cell values, and marks a refused file as a failure', async () => {
    const { logSpreadsheetImport } = await import('../src/audit/index.js');
    const db = createSqliteAdapter({ file: ':memory:' });
    const buffer = Buffer.from('file bytes');
    const mapped = { records: [{ row: 2, data: { name: 'secret-value' } }], errors: [{ row: 3, column: 'qty', code: 'REQUIRED' }, { row: 3, column: 'name', code: 'BAD_FORMAT', hint: 'x' }, { row: 4, column: 'qty', code: 'REQUIRED' }], truncated: false };
    const read = { format: 'xlsx', sheets: [{ rows: [[1], [2], [3]] }], warnings: [{ code: 'FORMULAS', count: 2 }] };
    const e = logSpreadsheetImport(db, { actor: 'anna', ip: '10.0.0.5' }, { buffer, fileName: 'C:\\x\\orders.xlsx', read, mapped });
    expect(e.result).toBe('success');
    const { sha256, ...rest } = e.meta;
    expect(rest).toEqual({ bytes: 10, fileName: 'orders.xlsx', format: 'xlsx', sheets: 1, rowsRead: 3, warnings: { FORMULAS: 2 }, accepted: 1, rejectedRows: 2, errorCodes: { REQUIRED: 2, BAD_FORMAT: 1 } });
    expect(sha256.length).toBe(64);
    expect(JSON.stringify(e.meta).includes('secret-value')).toBe(false);
    const f = logSpreadsheetImport(db, { actor: 'anna' }, { buffer, error: Object.assign(new Error('x'), { code: 'TOO_BIG' }) });
    expect(f.result).toBe('failure');
    expect(f.meta.errorCode).toBe('TOO_BIG');
    expect(count(db, { action: 'import.spreadsheet' })).toBe(2);
    db.close();
  });
});
