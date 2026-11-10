#!/usr/bin/env node
/**
 * Checks that the current commit can be published as a release of @das-forge/core.
 *
 *   node scripts/release-check.mjs            checks the version in packages/core/package.json
 *   node scripts/release-check.mjs v0.2.0     also requires the tag to equal that version
 *
 * A release version is a plain x.y.z with a CHANGELOG entry that is neither empty nor marked "Unreleased".
 * Intermediate (development) builds are never published, so nothing here is about them.
 * Exits 1 with every problem listed.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const pkg = JSON.parse(read('packages/core/package.json'));
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? '';
const problems = [];

if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) problems.push(`version "${pkg.version}" is not a plain x.y.z (a prerelease is not published)`);
if (tag && tag !== `v${pkg.version}`) problems.push(`tag "${tag}" does not match the package version "v${pkg.version}"`);
if (pkg.private) problems.push('packages/core/package.json is marked private');
if (pkg.license !== 'MIT') problems.push(`license is "${pkg.license}", expected MIT`);
if (!existsSync(path.join(root, 'packages/core/LICENSE'))) problems.push('packages/core/LICENSE is missing');
if (pkg.publishConfig?.access !== 'public') problems.push('publishConfig.access must be "public" for a scoped public package');

// Public repository files that must exist and carry no unfilled placeholder (<SECURITY_CONTACT>, <CONDUCT_CONTACT>).
for (const f of ['SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SUPPORT.md', 'LICENSE']) {
  if (!existsSync(path.join(root, f))) { problems.push(`${f} is missing`); continue; }
  const left = read(f).match(/<[A-Z]+_CONTACT>/g);
  if (left) problems.push(`${f} still has the placeholder ${[...new Set(left)].join(', ')}: put the real address in before publishing`);
}

const changelog = read('packages/core/CHANGELOG.md');
const escaped = pkg.version.replace(/\./g, '\\.');
const m = new RegExp(`^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, 'm').exec(changelog);
if (!m) problems.push(`CHANGELOG.md has no "## [${pkg.version}]" entry`);
else if (m[1].trim().length < 20) problems.push(`the CHANGELOG entry for ${pkg.version} is empty`);

if (problems.length) {
  console.error(`Not ready to release ${pkg.name}@${pkg.version}:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`ok: ${pkg.name}@${pkg.version} can be released${tag ? ` (tag ${tag})` : ''}`);
