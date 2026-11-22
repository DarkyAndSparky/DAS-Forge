import { describe, it, expect } from 'vitest';
import { isSafeEntryName } from '../src/scheduler/backup-archive.js';

describe('isSafeEntryName (audit S-07)', () => {
  it('accepts ordinary entries', () => {
    for (const n of ['manifest.json', 'database.sqlite', 'uploads/a.png', 'uploads/dir/', 'uploads/dir/file.name.txt', 'uploads/Console.png']) expect(isSafeEntryName(n), n).toBe(true);
  });
  it('refuses traversal and absolute paths', () => {
    for (const n of ['../x', 'uploads/../x', '/etc/passwd', 'C:/x', 'a\\b', '', 'a\0b']) expect(isSafeEntryName(n), JSON.stringify(n)).toBe(false);
  });
  it('refuses NTFS streams, Windows device names and names that end with a dot or a blank', () => {
    for (const n of ['uploads/x.png:stream', 'uploads/CON', 'uploads/con.png', 'uploads/Nul.txt', 'uploads/COM1', 'uploads/lpt9.log', 'uploads/AUX/file', 'uploads/name.', 'uploads/name ']) expect(isSafeEntryName(n), n).toBe(false);
  });
});
