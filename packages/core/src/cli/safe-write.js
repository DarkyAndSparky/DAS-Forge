import { chmodSync, writeFileSync } from 'node:fs';

import { ArgError } from './arg-parser.js';

/**
 * Writes an export that holds personal data: owner-only (0600) and never over an
 * existing file unless `force` says so (audit G04). On Windows the mode is
 * largely ignored by the OS; keep such files in a protected folder.
 */
export function writeOwnerOnly(file, data, { force = false } = {}) {
  if (typeof file !== 'string' || file === '') throw new ArgError('an output file name is required');
  try {
    writeFileSync(file, data, { mode: 0o600, flag: force ? 'w' : 'wx' });
  } catch (err) {
    if (err?.code === 'EEXIST') throw new ArgError(`${file} already exists; pass --force to overwrite it`);
    throw err;
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    /* not supported on this platform */
  }
}
