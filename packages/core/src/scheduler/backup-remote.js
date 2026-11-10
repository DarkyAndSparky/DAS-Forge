import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readdirSync, statSync, unlinkSync, renameSync, chmodSync, fsyncSync, openSync, closeSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { SftpDestinationConfigSchema, MountDestinationConfigSchema } from '../config/schema.js';
import { resolveEnvRef } from '../logs/sinks.js';

/**
 * Backup targets other than a plain local directory (audit L01): a mounted network share and SFTP.
 * A backup next to the database dies with the machine, so the copy has to leave it.
 *
 * Every target has the same small interface so the job treats them alike:
 *   preflight()                        - throws if the target is not safe/usable right now
 *   put(localFile, name)               - uploads under a temporary name, verifies, renames; -> {location, bytes, sha256, verified}
 *   list()                             - [{name, size}] of backup files there
 *   remove(name)
 *   close()
 *
 * Safety rules (they are what makes this "remote backup" and not a facade):
 *  - the archive is uploaded as `<name>.tmp` and renamed only after it was verified
 *    (size, and by default a SHA-256 read back from the target), so a cut connection never
 *    leaves something that looks like a good backup;
 *  - a mount target never creates its root directory (an unmounted share would silently fill the
 *    local disk), refuses a path on the same device as the data directory, and can require a marker file;
 *  - an SFTP target needs the server's host key fingerprint in the config (no trust-on-first-use);
 *    secrets are `env:NAME` references, never literals in the config file;
 *  - the job refuses to send an unencrypted archive off the machine unless `allowUnencrypted` is set.
 */

const BACKUP_FILE = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.zip(?:\.enc)?$/;
export const isBackupFileName = (name) => BACKUP_FILE.test(name);

/** A file name that cannot leave the destination directory: no separators, no `..`, no NUL. Throws otherwise. */
export function assertPlainName(name) {
  const n = String(name ?? '');
  if (!n || n === '.' || n === '..' || /[\\/\0]/.test(n)) throw new Error(`unsafe backup file name: ${JSON.stringify(n).slice(0, 80)}`);
  return n;
}

export async function hashStream(stream) {
  const h = createHash('sha256');
  for await (const chunk of stream) h.update(chunk);
  return h.digest('hex');
}

export const hashFile = (file) => hashStream(createReadStream(file));

/** OpenSSH "SHA256:base64" or hex (with or without colons) -> lowercase hex. */
export function normalizeFingerprint(text) {
  const s = String(text).trim();
  if (/^SHA256:/i.test(s)) return Buffer.from(s.slice(7), 'base64').toString('hex');
  return s.replace(/:/g, '').toLowerCase();
}

function fingerprintsEqual(a, b) {
  const x = Buffer.from(normalizeFingerprint(a));
  const y = Buffer.from(normalizeFingerprint(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Which of `files` ({name,size,time}) retention removes: older than retentionDays, never the newest minKeep. */
export function selectExpired(files, retentionDays, minKeep, now = Date.now()) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return [...files].sort((a, b) => b.time - a.time).slice(minKeep).filter((f) => f.time < cutoff);
}

// ---------------------------------------------------------------- mounted path

export function createMountTarget(destination, { localCheckPath = null, platform = process.platform } = {}) {
  if (!destination.path) throw new Error(`backup destination "${destination.id}" (mount) needs "path"`);
  const cfg = MountDestinationConfigSchema.parse(destination.config ?? {});
  const root = destination.path;

  return {
    id: destination.id,
    type: 'mount',
    options: cfg,
    preflight() {
      let st;
      try {
        st = statSync(root);
      } catch {
        throw new Error(`mount path ${root} does not exist - is the share mounted? (the directory is deliberately not created)`);
      }
      if (!st.isDirectory()) throw new Error(`mount path ${root} is not a directory`);
      if (cfg.markerFile && !existsSync(path.join(root, cfg.markerFile))) {
        throw new Error(`marker file "${cfg.markerFile}" not found in ${root} - the share is probably not mounted`);
      }
      if (!cfg.allowSameDevice && localCheckPath && platform !== 'win32') {
        const local = statSync(localCheckPath);
        if (local.dev === st.dev) {
          throw new Error(
            `${root} is on the same device as ${localCheckPath} - that is not a remote copy (an unmounted share? set config.allowSameDevice=true only for tests)`
          );
        }
      }
    },
    async put(localFile, name) {
      const finalPath = path.join(root, assertPlainName(name));
      const tmp = `${finalPath}.tmp`;
      const sourceHash = await hashFile(localFile);
      const bytes = statSync(localFile).size;
      try {
        await pipeline(createReadStream(localFile), createWriteStream(tmp, { mode: 0o600 }));
        const fd = openSync(tmp, 'r+');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        if (statSync(tmp).size !== bytes) throw new Error('size mismatch after copy');
        if (cfg.verify === 'hash' && (await hashFile(tmp)) !== sourceHash) throw new Error('checksum mismatch after copy');
        try {
          chmodSync(tmp, 0o600);
        } catch {
          /* share without POSIX modes */
        }
        renameSync(tmp, finalPath);
      } catch (err) {
        try {
          unlinkSync(tmp);
        } catch {
          /* nothing to clean */
        }
        throw err;
      }
      return { location: finalPath, bytes, sha256: sourceHash, verified: cfg.verify };
    },
    async list() {
      return readdirSync(root)
        .filter(isBackupFileName)
        .map((name) => {
          const st = statSync(path.join(root, name));
          return { name, size: st.size, mtimeMs: st.mtimeMs };
        });
    },
    async remove(name) {
      unlinkSync(path.join(root, assertPlainName(name)));
    },
    async close() {},
  };
}

// ---------------------------------------------------------------------- SFTP

async function loadSsh2() {
  try {
    const mod = await import('ssh2');
    return mod.Client ? mod : mod.default;
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') throw new Error('SFTP backups need the "ssh2" package (npm install ssh2)');
    throw err;
  }
}

const call = (fn) => new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value))));

/**
 * @param {object} destination - {id, type:'sftp', config}
 * @param {object} [o]
 * @param {object} [o.ssh2] - injected module (tests); default: the real `ssh2` package, loaded on demand
 * @param {object} [o.env]
 */
export function createSftpTarget(destination, { ssh2 = null, env = process.env } = {}) {
  const cfg = SftpDestinationConfigSchema.parse(destination.config ?? {});
  let client = null;
  let sftp = null;

  const remote = (name) => `${cfg.remotePath.replace(/\/+$/, '')}/${assertPlainName(name)}`;

  async function connect() {
    if (sftp) return;
    const mod = ssh2 ?? (await loadSsh2());
    const options = {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      readyTimeout: cfg.readyTimeoutMs,
      keepaliveInterval: cfg.keepaliveMs,
      hostHash: 'sha256',
      // No trust-on-first-use: the fingerprint comes from the config, anything else is refused.
      hostVerifier: (hash) => fingerprintsEqual(String(hash), cfg.hostKeySha256),
    };
    if (cfg.privateKey) options.privateKey = resolveEnvRef(cfg.privateKey, env);
    else if (cfg.privateKeyFile) options.privateKey = readFileSync(cfg.privateKeyFile);
    if (cfg.passphrase) options.passphrase = resolveEnvRef(cfg.passphrase, env);
    if (cfg.password) options.password = resolveEnvRef(cfg.password, env);

    client = new mod.Client();
    await new Promise((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', (err) => reject(err?.level === 'handshake' ? new Error(`SSH handshake failed (host key mismatch?): ${err.message}`) : err));
      client.connect(options);
    });
    sftp = await call((cb) => client.sftp(cb));
  }

  const stat = (p) => call((cb) => sftp.stat(p, cb));

  return {
    id: destination.id,
    type: 'sftp',
    options: cfg,
    async preflight() {
      await connect();
      let st;
      try {
        st = await stat(cfg.remotePath);
      } catch {
        throw new Error(`remote directory ${cfg.remotePath} does not exist on ${cfg.host} (create it first; the job only writes inside it)`);
      }
      if (typeof st.isDirectory === 'function' && !st.isDirectory()) throw new Error(`${cfg.remotePath} on ${cfg.host} is not a directory`);
    },
    async put(localFile, name) {
      await connect();
      const finalPath = remote(name);
      const tmp = `${finalPath}.tmp`;
      const sourceHash = await hashFile(localFile);
      const bytes = statSync(localFile).size;
      try {
        await call((cb) => sftp.fastPut(localFile, tmp, { concurrency: 8, chunkSize: 32768, mode: 0o600 }, cb));
        const st = await stat(tmp);
        if (Number(st.size) !== bytes) throw new Error(`size mismatch on the server (${st.size} != ${bytes})`);
        if (cfg.verify === 'hash' && (await hashStream(sftp.createReadStream(tmp))) !== sourceHash) {
          throw new Error('checksum mismatch on the server');
        }
        await call((cb) => sftp.rename(tmp, finalPath, cb));
      } catch (err) {
        try {
          await call((cb) => sftp.unlink(tmp, cb));
        } catch {
          /* nothing to clean */
        }
        throw err;
      }
      return { location: `sftp://${cfg.host}${finalPath.startsWith('/') ? '' : '/'}${finalPath}`, bytes, sha256: sourceHash, verified: cfg.verify };
    },
    async list() {
      await connect();
      const items = await call((cb) => sftp.readdir(cfg.remotePath, cb));
      return items
        .filter((i) => isBackupFileName(i.filename))
        .map((i) => ({ name: i.filename, size: Number(i.attrs?.size ?? 0), mtimeMs: Number(i.attrs?.mtime ?? 0) * 1000 }));
    },
    async remove(name) {
      await connect();
      await call((cb) => sftp.unlink(remote(name), cb));
    },
    async close() {
      try {
        client?.end();
      } catch {
        /* already closed */
      }
      client = null;
      sftp = null;
    },
  };
}

export function createRemoteTarget(destination, opts = {}) {
  if (destination.type === 'mount') return createMountTarget(destination, opts);
  if (destination.type === 'sftp') return createSftpTarget(destination, opts);
  throw new Error(`no remote target for destination type "${destination.type}"`);
}

/** Prunes a target by the shared retention rule; a file that cannot be removed is skipped. */
export async function pruneTarget(target, { retentionDays, minKeep }) {
  const files = (await target.list()).map((f) => ({
    ...f,
    time: parseTime(f.name) ?? f.mtimeMs,
  }));
  const removed = [];
  for (const f of selectExpired(files, retentionDays, minKeep)) {
    try {
      await target.remove(f.name);
      removed.push(f.name);
    } catch {
      /* next run retries */
    }
  }
  return removed;
}

function parseTime(name) {
  const m = /^backup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(t) ? null : t;
}

/** Lists backups of sftp destinations (the mount ones are plain directories: listBackups handles them). */
export async function listRemoteBackups(destinations, { ssh2 = null, env = process.env } = {}) {
  const out = [];
  for (const d of destinations.filter((x) => x.type === 'sftp')) {
    const target = createSftpTarget(d, { ssh2, env });
    try {
      for (const f of await target.list()) {
        out.push({ destinationId: d.id, file: f.name, path: `sftp://${target.options.host}/${target.options.remotePath.replace(/^\/+/, '')}/${f.name}`, sizeBytes: f.size, encrypted: f.name.endsWith('.enc'), createdAt: new Date(parseTime(f.name) ?? f.mtimeMs).toISOString(), remote: true });
      }
    } catch (err) {
      out.push({ destinationId: d.id, type: 'sftp', error: err.message });
    } finally {
      await target.close();
    }
  }
  return out;
}
