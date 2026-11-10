import { readFileSync } from 'node:fs';

/**
 * The core version. The only place it is written down is `packages/core/package.json`; everything else
 * (the About page, the start banner, the documentation header) reads it from here or is stamped from it by
 * `node scripts/version.mjs`.
 */
export const CORE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
