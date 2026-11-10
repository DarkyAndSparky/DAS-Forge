import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineVendorIdentity } from './vendor-identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/core/src/branding/ -> packages/core/assets/brand
const CORE_ASSETS_DIR = path.resolve(__dirname, '../../assets/brand');

/**
 * The core's own vendor identity. Every app built on DAS-Forge pulls
 * this into its About page (per user decision: apps always link back
 * to the core with its logo, not just a text mention).
 *
 * NOTE: assets/brand/logo.png and logo-dark.png are the real beta
 * artwork (0.1.10, a hexagonal anvil mark) - they replaced the earlier
 * placeholder "DF" monogram SVGs (see assets/brand/README.md). Vector
 * (.svg) versions of the same mark are expected later; the resolver
 * already prefers .svg over .png automatically, zero code changes
 * needed when they arrive.
 */
export const CORE_IDENTITY = defineVendorIdentity({
  name: 'DAS-Forge',
  repoUrl: 'https://github.com/DarkyAndSparky/DAS-Forge',
  assetsDir: CORE_ASSETS_DIR,
});
