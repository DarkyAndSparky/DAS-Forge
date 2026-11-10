#!/usr/bin/env node
/**
 * Keeps the dependency tables of docs/guide/12-dependencies.md in step with the package.json files:
 * the block between <!--deps-table:NAME--> and <!--/deps-table:NAME--> is regenerated, the text around it is hand-written.
 * Run by `npm run docs` (build-docs.mjs); can also be run alone.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPENDENCY_PURPOSE } from '../packages/core/src/admin/dependencies.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(path.join(root, p), 'utf8'));
const guide = path.join(root, 'docs/guide/12-dependencies.md');

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|');

function coreTable() {
  const pkg = read('packages/core/package.json');
  const meta = pkg.peerDependenciesMeta ?? {};
  const rows = [
    ...Object.entries(pkg.dependencies ?? {}).map(([n, r]) => [n, r, 'dependency']),
    ...Object.entries(pkg.peerDependencies ?? {}).map(([n, r]) => [n, r, meta[n]?.optional ? 'peer, необязательная' : 'peer']),
  ];
  const lines = ['| Пакет | Версия | Тип | Загрузка | Назначение |', '|---|---|---|---|---|'];
  for (const [n, r, kind] of rows) {
    const p = DEPENDENCY_PURPOSE[n];
    lines.push(`| \`${n}\` | \`${r}\` | ${kind} | ${p ? (p.load === 'lazy' ? 'по требованию' : 'всегда') : '?'} | ${cell(p?.ru ?? 'НЕ ОПИСАН')} |`);
  }
  return lines.join('\n');
}

function appTable() {
  const pkg = read('templates/app/package.json');
  const lines = ['| Пакет | Версия |', '|---|---|'];
  for (const [n, r] of Object.entries(pkg.dependencies ?? {})) lines.push(`| \`${n}\` | \`${r}\` |`);
  return lines.join('\n');
}

function devTable() {
  const seen = new Map();
  for (const p of ['package.json', 'packages/core/package.json', 'examples/workshop/package.json', 'templates/app/package.json']) {
    for (const [n, r] of Object.entries(read(p).devDependencies ?? {})) if (!seen.has(n)) seen.set(n, [r, p.replace(/\/?package\.json$/, '') || 'корень']);
  }
  const lines = ['| Пакет | Версия | Где |', '|---|---|---|'];
  for (const [n, [r, where]] of seen) lines.push(`| \`${n}\` | \`${r}\` | ${where} |`);
  return lines.join('\n');
}

function overridesTable() {
  const o = read('package.json').overrides ?? {};
  const lines = ['| Пакет | Версия |', '|---|---|'];
  for (const [n, r] of Object.entries(o)) lines.push(`| \`${n}\` | \`${r}\` |`);
  return lines.join('\n');
}

export function updateDependencyGuide() {
  let text = readFileSync(guide, 'utf8');
  const blocks = { core: coreTable(), app: appTable(), dev: devTable(), overrides: overridesTable() };
  for (const [name, body] of Object.entries(blocks)) {
    const re = new RegExp(`(<!--deps-table:${name}-->)[\\s\\S]*?(<!--/deps-table:${name}-->)`);
    if (!re.test(text)) throw new Error(`docs/guide/12-dependencies.md: marker deps-table:${name} not found`);
    text = text.replace(re, `$1\n${body}\n$2`);
  }
  writeFileSync(guide, text);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  updateDependencyGuide();
  console.log('docs/guide/12-dependencies.md: tables updated');
}
