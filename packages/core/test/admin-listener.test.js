import { describe, it, expect } from 'vitest';
import { adminGate, resolveAdminListener } from '../src/http/admin-listener.js';
import { cliActor } from '../src/cli/actor.js';
import { hardeningChecks } from '../src/health/checks/hardening.js';
import { ServerConfigSchema } from '../src/config/schema.js';

function run(gate, path, localPort) {
  let outcome = 'next';
  const req = { path, socket: { localPort } };
  const res = { locals: {}, status(c) { outcome = c; return this; }, json() { return this; } };
  gate(req, res, () => { outcome = 'next'; });
  return outcome;
}

describe('administration listener', () => {
  it('is off without a port, loopback by default with one', () => {
    expect(resolveAdminListener({ port: 9002 })).toBe(null);
    expect(resolveAdminListener({ port: 9002, admin: { port: 9003 } })).toEqual({ host: '127.0.0.1', port: 9003 });
    expect(resolveAdminListener({ port: 9002, admin: { host: '10.0.0.5', port: 9003 } })).toEqual({ host: '10.0.0.5', port: 9003 });
  });
  it('refuses a port the application already uses', () => {
    expect(() => resolveAdminListener({ port: 9002, admin: { port: 9002 } })).toThrow(/already used/);
    expect(() => resolveAdminListener({ port: 9002, httpRedirectPort: 9001, admin: { port: 9001 } })).toThrow(/already used/);
  });
  it('hides the panel on every other port and lets the rest through', () => {
    const gate = adminGate({ port: 9003 });
    expect(run(gate, '/admin', 9002)).toBe(404);
    expect(run(gate, '/admin/users', 9002)).toBe(404);
    expect(run(gate, '/admin', 9003)).toBe('next');
    expect(run(gate, '/admin/users', 9003)).toBe('next');
    expect(run(gate, '/ui', 9002)).toBe('next');
    expect(run(gate, '/administrator', 9002)).toBe('next'); // another path with the same beginning
    expect(run(gate, '/login', 9003)).toBe('next');
  });
  it('the schema keeps the admin address optional', () => {
    expect(ServerConfigSchema.parse({}).admin).toEqual({});
    expect(ServerConfigSchema.parse({ admin: { port: 9103 } }).admin.port).toBe(9103);
  });
  it('the diagnostics tell a separate listener from a shared one', async () => {
    const find = async (server) => (await hardeningChecks({ appConfig: { server } })).find((c) => c.name === 'Administration address');
    expect((await find({ host: '0.0.0.0', port: 1, admin: { port: 2 } })).status).toBe('ok');
    expect((await find({ host: '127.0.0.1', port: 1 })).status).toBe('ok');
    expect((await find({ host: '0.0.0.0', port: 1 })).status).toBe('warn');
  });
});

describe('who a console command acts as', () => {
  it('is cli/<os user>, cleaned, or plain cli when unknown', () => {
    expect(cliActor(() => ({ username: 'deploy' }))).toBe('cli/deploy');
    expect(cliActor(() => ({ username: 'a b\n<x>' }))).toBe('cli/abx');
    expect(cliActor(() => { throw new Error('no user'); })).toBe('cli');
    expect(cliActor(() => ({ username: '' }))).toBe('cli');
  });
});

describe('adminHosts / listenAdmin', () => {
  it('binds the loopback address in both families so localhost works either way', async () => {
    const { adminHosts } = await import('../src/http/admin-listener.js');
    expect(adminHosts('127.0.0.1')).toEqual(['127.0.0.1', '::1']);
    expect(adminHosts('::1')).toEqual(['::1', '127.0.0.1']);
    expect(adminHosts('10.0.0.5')).toEqual(['10.0.0.5']);
  });

  it('starts both, tolerates a missing second family, and closes everything', async () => {
    const { listenAdmin } = await import('../src/http/admin-listener.js');
    const http = await import('node:http');
    const skipped = [];
    const l = await listenAdmin({ createServer: () => http.createServer((q, r) => r.end('ok')), address: { host: '127.0.0.1', port: 0 }, onSkip: (h) => skipped.push(h) });
    expect(l.bound[0].host).toBe('127.0.0.1');
    expect(l.servers.length + skipped.length).toBe(2);
    await l.close();
    expect(l.servers.every((s) => !s.listening)).toBe(true);
  });
});
