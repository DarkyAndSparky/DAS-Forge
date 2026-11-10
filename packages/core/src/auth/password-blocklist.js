import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

/**
 * Checks a password against a local list of leaked passwords in the "Pwned Passwords" format
 * (`SHA1HEX:count`, one per line, sorted by hash, "ordered by hash" download). Nothing leaves the machine:
 * the file is searched by bisection, so a list of many gigabytes needs no memory.
 *
 * @param {string} file
 * @returns {{ has(plain: string): Promise<boolean> }}
 */
export function createPasswordBlocklist(file) {
  if (typeof file !== 'string' || file === '') throw new TypeError('createPasswordBlocklist: file is required');
  const LINE = 64; // longest line read at once: 40 hex + ":" + count
  return {
    async has(plain) {
      const want = createHash('sha1').update(String(plain), 'utf8').digest('hex').toUpperCase();
      let fh;
      try {
        fh = await open(file, 'r');
        const { size } = await fh.stat();
        const buf = Buffer.alloc(LINE * 2);
        // Invariant: `lo` is the start of a line and the wanted line, if present, starts in [lo, hi).
        let lo = 0;
        let hi = size;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          let lineStart = lo;
          if (mid > lo) {
            const { bytesRead } = await fh.read(buf, 0, buf.length, mid - 1);
            const text = buf.toString('latin1', 0, bytesRead);
            if (text[0] === '\n') lineStart = mid;
            else {
              const nl = text.indexOf('\n');
              if (nl === -1) { hi = mid; continue; }
              lineStart = mid - 1 + nl + 1;
            }
            if (lineStart >= hi) { hi = mid; continue; }
          }
          const { bytesRead } = await fh.read(buf, 0, buf.length, lineStart);
          const text = buf.toString('latin1', 0, bytesRead);
          const end = text.indexOf('\n');
          const line = (end === -1 ? text : text.slice(0, end)).replace(/\r$/, '');
          const hash = line.slice(0, 40).toUpperCase();
          if (hash === want) return true;
          if (hash < want) lo = end === -1 ? size : lineStart + end + 1;
          else hi = mid > lo ? mid : lineStart; // mid === lo: this very line is too big, nothing before it is left
          if (mid === lo && hash >= want) break;
        }
        return false;
      } catch {
        return false; // an unreadable list never blocks a sign-up
      } finally {
        await fh?.close().catch(() => {});
      }
    },
  };
}
