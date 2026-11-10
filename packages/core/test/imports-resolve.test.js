import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression for 0.1.272: a wrong relative path in one rarely-loaded file broke 37 test files.
// Every relative import in src/ and test/ must point at a file that exists.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('relative imports', () => {
  it('all resolve to existing files', () => {
    const missing = [];
    for (const dir of ['src', 'test']) {
      for (const file of walk(path.join(root, dir))) {
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
          if (!fs.existsSync(path.resolve(path.dirname(file), m[1]))) missing.push(`${path.relative(root, file)} -> ${m[1]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
