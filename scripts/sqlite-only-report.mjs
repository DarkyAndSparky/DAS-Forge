#!/usr/bin/env node
// Lists, per file, the SQL in packages/core/src that PostgreSQL cannot run after `translate()` (ADR-0010, dialect layer).
// Usage: node scripts/sqlite-only-report.mjs [--json] [--files-only]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSqliteOnly } from '../packages/core/src/database/dialect.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'core', 'src');
const SQL_START = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|WITH|VACUUM|REPLACE|BEGIN|COMMIT)\b/i;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.endsWith('.js')) yield full;
  }
}

/** String literals that look like SQL: template strings and quoted strings, one level (no nesting of `${}`). */
function sqlLiterals(source) {
  const found = [];
  const re = /`((?:\\.|[^`\\])*)`|'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"/g;
  for (const m of source.matchAll(re)) {
    const text = m[1] ?? m[2] ?? m[3] ?? '';
    if (SQL_START.test(text)) found.push({ text: text.replace(/\$\{[^}]*\}/g, 'x'), at: m.index });
  }
  return found;
}

const report = {};
for (const file of walk(root)) {
  const source = readFileSync(file, 'utf8');
  for (const { text, at } of sqlLiterals(source)) {
    const why = findSqliteOnly(text);
    if (why.length === 0) continue;
    const rel = path.relative(root, file).split(path.sep).join('/');
    const line = source.slice(0, at).split('\n').length;
    (report[rel] ??= []).push({ line, why });
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const files = Object.keys(report).sort();
  for (const f of files) {
    if (process.argv.includes('--files-only')) { console.log(`${f}: ${report[f].length}`); continue; }
    for (const { line, why } of report[f]) console.log(`${f}:${line}  ${why.join('; ')}`);
  }
  const total = files.reduce((n, f) => n + report[f].length, 0);
  console.log(`\n${total} statement(s) in ${files.length} file(s) still need SQLite.`);
}
