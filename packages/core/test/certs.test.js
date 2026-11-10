import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCertInfo } from '../src/certs/info.js';
import { certFilePaths, writeCertFiles } from '../src/certs/store.js';
import { certChecks } from '../src/certs/doctor-check.js';
import { createCli } from '../src/cli/cli.js';
import { registerCertCommands } from '../src/cli/commands/certs.js';
import { generateSelfSignedCert } from '../src/certs/generate.js';

// Uses the REAL generateSelfSignedCert() (core/certs/generate.js,
// `selfsigned` package) as the test fixture generator - previously
// shelled out to the `openssl` CLI, which doesn't exist on a stock
// Windows machine (confirmed by a real `npm test` run: all tests using
// it failed with "'openssl' is not recognized", an environment problem
// having nothing to do with the code under test). `selfsigned` is
// already this project's own dependency and needs no external binary
// on any OS, so there is no good reason to depend on a second,
// optional one just for test fixtures - and this also means
// generateSelfSignedCert() itself finally gets exercised by a live
// test run, closing the one gap that was previously undtestable in
// the sandboxed dev container (no network there to install
// `selfsigned`) but IS testable wherever `npm install` actually ran.
async function makeCert(dir, { days = 20, commonName = 'localhost', altNames = ['workshop.local', '127.0.0.1'] } = {}) {
  return generateSelfSignedCert({ commonName, altNames, days });
}

describe('certs: store (writeCertFiles / certFilePaths)', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'das-forge-certs-store-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Windows/NTFS has no POSIX permission bits: chmod() there only
  // toggles the read-only attribute, and statSync().mode reports a
  // synthesized 0o666/0o444 rather than the real mode writeCertFiles()
  // requested - confirmed by a real `npm test` run on Windows, not an
  // assumption. writeCertFiles() itself is unchanged (it still always
  // requests 0o600, which is the correct and only thing it can do), but
  // the exact-mode assertion below is a POSIX-only guarantee, so it's
  // skipped on win32 rather than weakened for every platform.
  const itPosixOnly = process.platform === 'win32' ? it.skip : it;

  it('writes cert.pem and key.pem, with the key owner-only (0600)', async () => {
    const pems = await makeCert(root);
    const certDir = path.join(root, 'out');
    const paths = writeCertFiles(certDir, pems);

    expect(existsSync(paths.certPath)).toBe(true);
    expect(existsSync(paths.keyPath)).toBe(true);
    expect(paths).toEqual(certFilePaths(certDir));
  });

  itPosixOnly('key file is owner-only (0600) on POSIX filesystems', async () => {
    const pems = await makeCert(root);
    const certDir = path.join(root, 'out');
    const paths = writeCertFiles(certDir, pems);
    expect(statSync(paths.keyPath).mode & 0o777).toBe(0o600);
  });

  itPosixOnly('re-applies 0600 on overwrite, not just on first create', async () => {
    const pems = await makeCert(root);
    const certDir = path.join(root, 'out');
    const paths = writeCertFiles(certDir, pems);
    writeCertFiles(certDir, pems); // overwrite
    expect(statSync(paths.keyPath).mode & 0o777).toBe(0o600);
  });
});

describe('certs: readCertInfo', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'das-forge-certs-info-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('parses subject, SAN, self-signed status, and days remaining from a real certificate', async () => {
    const pems = await makeCert(root, { days: 20 });
    const { certPath } = writeCertFiles(path.join(root, 'out'), pems);

    const info = readCertInfo(certPath);
    expect(info.subject).toBe('CN=localhost');
    expect(info.selfSigned).toBe(true);
    expect(info.daysRemaining).toBeGreaterThan(18);
    expect(info.daysRemaining).toBeLessThanOrEqual(20);
    expect(info.subjectAltName).toMatch(/localhost/);
    expect(info.subjectAltName).toMatch(/workshop\.local/);
    expect(info.subjectAltName).toMatch(/127\.0\.0\.1/);
  });

  it('throws for a missing file', () => {
    expect(() => readCertInfo(path.join(root, 'nope.pem'))).toThrow();
  });
});

describe('certs: certChecks (doctor category)', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'das-forge-certs-doctor-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fails cleanly when no certificate exists', () => {
    const checks = certChecks(path.join(root, 'missing.pem'));
    expect(checks[0]).toMatchObject({ name: 'Certificate', status: 'fail' });
  });

  it('warns inside the warnDays window and is ok outside it', async () => {
    const pems = await makeCert(root, { days: 20 });
    const { certPath } = writeCertFiles(path.join(root, 'out'), pems);

    expect(certChecks(certPath, { warnDays: 30 })[0].status).toBe('warn');
    expect(certChecks(certPath, { warnDays: 5 })[0].status).toBe('ok');
  });

  it('flags a self-signed certificate as an advisory warning, not a failure', async () => {
    const pems = await makeCert(root, { days: 400 });
    const { certPath } = writeCertFiles(path.join(root, 'out'), pems);

    const checks = certChecks(certPath, { warnDays: 30 });
    expect(checks.find((c) => c.name === 'Certificate').status).toBe('ok');
    expect(checks.find((c) => c.name === 'Certificate trust')).toMatchObject({ status: 'warn' });
  });
});

describe('registerCertCommands', () => {
  let root;
  let certDir;
  let certPath;
  let generateCalls;

  async function capture(fn) {
    const logs = [];
    const errs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => logs.push(a.join(' '));
    console.error = (...a) => errs.push(a.join(' '));
    let code;
    try {
      code = await fn();
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    return { code, logs, errs };
  }

  beforeEach(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'das-forge-certs-cli-'));
    certDir = path.join(root, 'certs');
    const pems = await makeCert(root, { days: 20 });
    ({ certPath } = writeCertFiles(certDir, pems));
    generateCalls = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function buildCli() {
    const cli = createCli();
    registerCertCommands(cli, {
      certPath,
      certDir,
      readCertInfoFn: readCertInfo,
      generateCertFn: async (opts) => {
        generateCalls.push(opts);
        return makeCert(root, { days: opts.days ?? 365, commonName: opts.commonName, altNames: opts.altNames });
      },
      writeCertFilesFn: writeCertFiles,
      defaultCommonName: 'localhost',
    });
    return cli;
  }

  it('info prints human and json forms, and reflects a real parsed certificate', async () => {
    const cli = buildCli();

    let r = await capture(() => cli.run(['cert', 'info']));
    expect(r.code).toBe(0);
    expect(r.logs.join('\n')).toMatch(/certificate valid/);

    r = await capture(() => cli.run(['cert', 'info', '--json']));
    expect(JSON.parse(r.logs[0]).subject).toBe('CN=localhost');
  });

  it('trust prints the real cert path and OS-specific instructions', async () => {
    const cli = buildCli();
    const r = await capture(() => cli.run(['cert', 'trust']));
    expect(r.logs.join('\n')).toContain(certPath);
    expect(r.logs.join('\n')).toMatch(/update-ca-certificates/);
    expect(r.logs.join('\n')).toMatch(/Import-Certificate/);
  });

  it('generate refuses to overwrite without --force, proceeds with it', async () => {
    const cli = buildCli();

    let r = await capture(() => cli.run(['cert', 'generate']));
    expect(r.code).toBe(1);
    expect(r.errs.join('\n')).toMatch(/already exists/);

    r = await capture(() => cli.run(['cert', 'generate', '--force', '--common-name', 'example.test', '--alt-names', 'foo.test,10.0.0.1']));
    expect(r.code).toBe(0);
    expect(generateCalls[0]).toMatchObject({ commonName: 'example.test' });
    expect(generateCalls[0].altNames).toContain('foo.test');
  });

  it('renew re-extracts the SAME subjectAltName from the existing certificate', async () => {
    const cli = buildCli();
    const r = await capture(() => cli.run(['cert', 'renew']));
    expect(r.code).toBe(0);

    const args = generateCalls[0];
    expect(args.commonName).toBe('localhost');
    expect(args.altNames).toEqual(expect.arrayContaining(['workshop.local', '127.0.0.1']));
  });

  it('renew keeps the old pair beside the new one and the same validity period', async () => {
    const cli = buildCli();
    const before = readdirSync(certDir).length;
    const r = await capture(() => cli.run(['cert', 'renew']));
    expect(r.code).toBe(0);
    expect(readdirSync(certDir).filter((f) => f.includes('.bak-')).length).toBeGreaterThan(0);
    expect(readdirSync(certDir).length).toBeGreaterThan(before);
    const days = generateCalls[0].days;
    expect(days).toBeGreaterThanOrEqual(1);
    expect(days).toBeLessThanOrEqual(3650);
  });

  it('info fails cleanly when no certificate exists yet', async () => {
    const cli = createCli();
    registerCertCommands(cli, {
      certPath: path.join(root, 'nope.pem'),
      certDir,
      readCertInfoFn: readCertInfo,
      generateCertFn: async () => ({ cert: '', key: '' }),
      writeCertFilesFn: writeCertFiles,
    });

    const r = await capture(() => cli.run(['cert', 'info']));
    expect(r.code).toBe(1);
    expect(r.errs.join('\n')).toMatch(/No certificate/);
  });
});
