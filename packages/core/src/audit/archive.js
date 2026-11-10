/**
 * Archive of audit rows before retention deletes them (audit chapter 3, stage E, R-14): a gzip-compressed
 * NDJSON file `audit-<from>-<to>.ndjson.gz` with every column including the hashes, and a `.sha256` file next to it.
 * The last line is a trailer that names the first and last row and the hash of the last one, so the archive can be
 * matched with a later `anchor` and with the chain left in the database.
 */
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, createReadStream } from 'node:fs';
import { createGzip, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { once } from 'node:events';
import { ensureAuditTable } from './schema.js';

const PAGE = 2000;
const stamp = (iso) => String(iso).replace(/[:.]/g, '-').replace(/[^0-9A-Za-z-]/g, '').slice(0, 19);

/**
 * Writes the rows older than `beforeIso` to `dir`. Nothing is deleted here.
 * @returns {Promise<null | {file: string, rows: number, firstId: number, lastId: number, lastHash: string|null, sha256: string}>} null when there is nothing to archive
 */
export async function archiveBefore(db, beforeIso, { dir } = {}) {
  if (!beforeIso) throw new TypeError('archiveBefore() requires a cutoff ISO datetime string');
  if (!dir) throw new TypeError('archiveBefore() requires a directory');
  ensureAuditTable(db);
  const first = db.get('SELECT MIN(created_at) AS a FROM audit_log WHERE created_at < ?', [beforeIso])?.a;
  if (!first) return null;
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const name = `audit-${stamp(first)}-${stamp(beforeIso)}.ndjson.gz`;
  const tmp = join(dir, `${name}.part`);
  const out = join(dir, name);
  const gz = createGzip();
  const sink = createWriteStream(tmp, { mode: 0o600 });
  gz.pipe(sink);

  const hash = createHash('sha256');
  let rows = 0; let firstId = null; let lastId = null; let lastHash = null; let afterId = -1;
  const write = async (line) => { if (!gz.write(`${line}\n`)) await once(gz, 'drain'); };
  try {
    for (;;) {
      const page = db.all('SELECT * FROM audit_log WHERE created_at < ? AND id > ? ORDER BY id LIMIT ?', [beforeIso, afterId, PAGE]);
      if (page.length === 0) break;
      for (const r of page) {
        await write(JSON.stringify(r));
        rows += 1; firstId ??= r.id; lastId = r.id; lastHash = r.hash ?? null;
      }
      afterId = page[page.length - 1].id;
    }
    await write(JSON.stringify({ trailer: true, rows, firstId, lastId, lastHash, before: beforeIso, archivedAt: new Date().toISOString() }));
    gz.end();
    await once(sink, 'finish');
  } catch (err) {
    gz.destroy(); sink.destroy();
    rmSync(tmp, { force: true });
    throw err;
  }
  await new Promise((resolve, reject) => { const s = createReadStream(tmp); s.on('data', (c) => hash.update(c)); s.on('end', resolve); s.on('error', reject); });
  const sha256 = hash.digest('hex');
  renameSync(tmp, out);
  writeFileSync(`${out}.sha256`, `${sha256}  ${name}\n`, { mode: 0o600 });
  return { file: out, rows, firstId, lastId, lastHash, sha256 };
}

/**
 * Checks an archive against its `.sha256` and its own trailer.
 * @returns {{ok: boolean, rows: number, reason?: string}}
 */
export function verifyArchive(file) {
  let raw;
  try { raw = readFileSync(file); } catch { return { ok: false, rows: 0, reason: 'archive cannot be read' }; }
  try {
    const expected = readFileSync(`${file}.sha256`, 'utf8').split(/\s+/)[0];
    if (createHash('sha256').update(raw).digest('hex') !== expected) return { ok: false, rows: 0, reason: 'checksum does not match' };
  } catch { return { ok: false, rows: 0, reason: 'checksum file is missing' }; }
  try {
    const lines = gunzipSync(raw).toString('utf8').trimEnd().split('\n');
    const trailer = JSON.parse(lines[lines.length - 1]);
    if (!trailer.trailer) return { ok: false, rows: 0, reason: 'trailer is missing' };
    if (trailer.rows !== lines.length - 1) return { ok: false, rows: lines.length - 1, reason: 'row count differs from the trailer' };
    return { ok: true, rows: trailer.rows };
  } catch { return { ok: false, rows: 0, reason: 'archive is damaged' }; }
}
