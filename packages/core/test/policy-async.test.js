import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createPolicy, ensurePolicyTableAsync } from '../src/policy/index.js';

const fresh = () => createSqliteAdapter({ file: ':memory:', walMode: false });

describe('policy texts over the asynchronous database', () => {
  it('defaults, custom text, reset; shares rows with the sync methods', async () => {
    const db = fresh();
    await ensurePolicyTableAsync(db);
    const p = createPolicy({ db });
    expect((await p.getTextAsync('en', 'usage')).custom).toBe(false);
    await p.setTextAsync('en', 'usage', 'Our rules', 'admin');
    const t = await p.getTextAsync('en', 'usage');
    expect(t.body).toBe('Our rules');
    expect(t.updatedBy).toBe('admin');
    expect(p.getText('en', 'usage').body).toBe('Our rules');
    let err;
    try { await p.setTextAsync('en', 'usage', '   '); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(await p.resetTextAsync('en', 'usage')).toBe(1);
    expect((await p.getTextAsync('en', 'usage')).custom).toBe(false);
  });
  it('rebuilds an old table without the licence kind and keeps its rows', async () => {
    const db = fresh();
    db.exec(`CREATE TABLE policy_texts (locale TEXT NOT NULL CHECK (locale IN ('ru','en')), kind TEXT NOT NULL CHECK (kind IN ('usage','cookies')), body TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT, PRIMARY KEY (locale, kind))`);
    db.run("INSERT INTO policy_texts VALUES ('ru','usage','старый','2020-01-01T00:00:00Z',NULL)");
    await ensurePolicyTableAsync(db);
    const p = createPolicy({ db });
    expect((await p.getTextAsync('ru', 'usage')).body).toBe('старый');
    await p.setTextAsync('ru', 'license', 'лицензия');
    expect((await p.getTextAsync('ru', 'license')).body).toBe('лицензия');
  });
});
