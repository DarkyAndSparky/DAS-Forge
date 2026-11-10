import path from 'node:path';

/**
 * One resolver for backup destination paths (audit B16): `local`/`mount` `path` and an sftp `privateKeyFile` that
 * are relative are resolved against `baseDir` (the application root), so the job, the CLI, the admin page and
 * `doctor` all see the same absolute path whichever directory the process started in. Returns new objects.
 */
export function resolveDestinations(destinations, baseDir) {
  const abs = (p) => (typeof p === 'string' && p !== '' ? path.resolve(baseDir, p) : p);
  return (destinations ?? []).map((d) => {
    if ((d.type === 'local' || d.type === 'mount') && d.path) return { ...d, path: abs(d.path) };
    if (d.type === 'sftp' && d.privateKeyFile) return { ...d, privateKeyFile: abs(d.privateKeyFile) };
    return d;
  });
}
