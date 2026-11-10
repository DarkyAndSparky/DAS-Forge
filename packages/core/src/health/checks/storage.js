import { existsSync, accessSync, mkdirSync, constants } from 'node:fs';

/**
 * Storage category: each named directory the app depends on (data,
 * uploads, backup destinations, ...) exists and is writable. A missing
 * directory is `fix`-able (mkdir -p); a directory that exists but isn't
 * writable is a permissions problem doctor can report but not safely
 * auto-fix (chmod-ing someone else's directory is not a "safe where
 * possible" fix per §4.5), so no `fix` is attached for that case.
 *
 * @param {Record<string, string | {path: string, optional?: boolean}>} dirs - label -> absolute path,
 *   e.g. { data: '/app/data', uploads: '/app/data/uploads' }. An `optional` directory (a backup
 *   destination before the first run) that is missing is a warning, not a failure.
 */
export function storageChecks(dirs = {}) {
  return Object.entries(dirs).map(([label, spec]) => {
    const dirPath = typeof spec === 'string' ? spec : spec.path;
    const optional = typeof spec === 'object' && spec.optional === true;
    if (!existsSync(dirPath)) {
      return {
        name: label,
        status: optional ? 'warn' : 'fail',
        message: optional ? `${dirPath} does not exist yet (created by the first backup)` : `${dirPath} does not exist`,
        fix: () => mkdirSync(dirPath, { recursive: true }),
      };
    }

    try {
      accessSync(dirPath, constants.W_OK);
      return { name: label, status: 'ok', message: `${dirPath} writable` };
    } catch {
      return { name: label, status: 'fail', message: `${dirPath} exists but is not writable` };
    }
  });
}
