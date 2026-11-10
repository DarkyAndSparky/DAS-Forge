import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Audit D03: importing the core barrel (or one module) must not load the
 * native/heavy dependencies - argon2, sharp, jsdom, dompurify, qrcode,
 * selfsigned. Proven in a clean child process whose module loader REFUSES
 * those specifiers: if any import of them happens at load time, the child
 * fails.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const indexUrl = pathToFileURL(path.resolve(here, '../src/index.js')).href;

const HOOKS = `
const BLOCKED = new Set(['argon2', 'sharp', 'jsdom', 'dompurify', 'qrcode', 'selfsigned', 'ssh2', 'ldapts', 'libheif-js', 'libheif-js/wasm-bundle', 'docx', 'i18next', 'nodemailer', 'multer', 'express-session', 'pino-pretty']);
export async function resolve(specifier, context, next) {
  if (BLOCKED.has(specifier)) throw new Error('BLOCKED-NATIVE-IMPORT:' + specifier);
  return next(specifier, context);
}`;

function runChild(body) {
  const code = `
    import { register } from 'node:module';
    register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(HOOKS)}), import.meta.url);
    ${body}
  `;
  return spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { encoding: 'utf8' });
}

describe('lazy native dependencies (D03)', () => {
  it('importing the whole core barrel loads none of the native/heavy packages', () => {
    const r = runChild(`const core = await import(${JSON.stringify(indexUrl)}); console.log(Object.keys(core).length);`);
    expect(r.stderr).not.toMatch(/BLOCKED-NATIVE-IMPORT/);
    expect(r.status).toBe(0);
    expect(Number(r.stdout.trim())).toBeGreaterThan(10);
  });

  it('the database module is usable without them', () => {
    const r = runChild(`
      const { database } = await import(${JSON.stringify(indexUrl)});
      const db = database.createSqliteAdapter({ file: ':memory:' });
      db.exec('CREATE TABLE t (x)');
      db.run('INSERT INTO t VALUES (1)');
      console.log(db.get('SELECT COUNT(*) AS n FROM t').n);
    `);
    expect(r.stderr).not.toMatch(/BLOCKED-NATIVE-IMPORT/);
    expect(r.stdout.trim()).toBe('1');
  });

  it('the dependency is requested only when its feature is actually used', () => {
    const r = runChild(`
      const { auth } = await import(${JSON.stringify(indexUrl)});
      try { await auth.hashPassword('x'); console.log('no-error'); } catch (e) { console.log(e.message); }
    `);
    expect(r.stdout).toMatch(/BLOCKED-NATIVE-IMPORT:argon2/);
  });
});
