import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { createSafeFetch, refusedAddress, outboundPolicyFromConfig, setOutboundPolicy } from '../src/http/safe-fetch.js';

const rejects = async (p, re) => { let e; try { await p; } catch (x) { e = x; } expect(e).toBeDefined(); expect(String(e.message)).toMatch(re); };

describe('refusedAddress', () => {
  it('always refuses link-local, metadata, multicast, unspecified (also IPv4-mapped)', () => {
    for (const ip of ['169.254.169.254', '0.0.0.1', '224.0.0.1', 'fe80::1', 'fd00:ec2::254', '::', '::ffff:169.254.169.254', 'ff02::1']) {
      expect(refusedAddress(ip, { allowPrivate: true }), ip).toBeTruthy();
    }
  });
  it('private ranges depend on allowPrivate and allowHosts', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.20.1.1', '192.168.1.1', '100.64.0.1', '::1', 'fd12::1', '::ffff:10.0.0.5']) {
      expect(refusedAddress(ip, { allowPrivate: true }), ip).toBeNull();
      expect(refusedAddress(ip, { allowPrivate: false }), ip).toBeTruthy();
    }
    expect(refusedAddress('8.8.8.8', { allowPrivate: false })).toBeNull();
    expect(refusedAddress('2606:4700::1111', { allowPrivate: false })).toBeNull();
  });
});

describe('safeFetch', () => {
  let srv;
  afterEach(() => new Promise((r) => (srv ? srv.close(() => r()) : r())));
  const start = (handler) => new Promise((r) => { srv = http.createServer(handler); srv.listen(0, '127.0.0.1', () => r(srv.address().port)); });

  it('refuses a name that resolves to a forbidden address', async () => {
    const f = createSafeFetch({ resolve: async () => ['169.254.169.254'] });
    await rejects(f('http://evil.example/'), /169\.254\.169\.254/);
    const g = createSafeFetch({ allowPrivate: false, resolve: async () => ['10.0.0.5'] });
    await rejects(g('http://internal.example/'), /private/);
  });
  it('refuses when ANY returned address is forbidden', async () => {
    const f = createSafeFetch({ resolve: async () => ['93.184.216.34', '169.254.169.254'] });
    await rejects(f('http://mixed.example/'), /169\.254/);
  });
  it('connects to the checked address; a second DNS answer is never used (rebinding)', async () => {
    const port = await start((req, res) => { res.setHeader('x-host', req.headers.host); res.end('ok'); });
    let calls = 0;
    const f = createSafeFetch({ resolve: async () => (++calls === 1 ? ['127.0.0.1'] : ['169.254.169.254']) });
    const r = await f(`http://rebind.example:${port}/p`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('ok');
    expect(r.headers.get('x-host')).toBe(`rebind.example:${port}`);
    expect(calls).toBe(1);
  });
  it('allowHosts keeps a named internal receiver reachable when private networks are refused', async () => {
    const port = await start((req, res) => res.end('hi'));
    const resolve = async () => ['127.0.0.1'];
    await rejects(createSafeFetch({ allowPrivate: false, resolve })(`http://hook.lan:${port}/`), /private/);
    const r = await createSafeFetch({ allowPrivate: false, allowHosts: ['hook.lan'], resolve })(`http://hook.lan:${port}/`);
    expect(await r.text()).toBe('hi');
    const r2 = await createSafeFetch({ allowPrivate: false, allowHosts: ['127.0.0.0/8'], resolve })(`http://hook.lan:${port}/`);
    expect(r2.status).toBe(200);
  });
  it('allowHosts does not lift the always-refused ranges', async () => {
    const f = createSafeFetch({ allowPrivate: false, allowHosts: ['metadata.lan', '169.254.0.0/16'], resolve: async () => ['169.254.169.254'] });
    await rejects(f('http://metadata.lan/'), /link-local/);
  });
  it('does not follow redirects, limits the size, sends method and body', async () => {
    const port = await start((req, res) => {
      if (req.url === '/redir') { res.statusCode = 302; res.setHeader('location', 'http://169.254.169.254/'); res.end(); return; }
      if (req.url === '/big') { res.end('x'.repeat(5000)); return; }
      let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => res.end(`${req.method}:${b}`));
    });
    const f = createSafeFetch({ maxBytes: 1000 });
    await rejects(f(`http://127.0.0.1:${port}/redir`), /not followed/);
    await rejects(f(`http://127.0.0.1:${port}/big`), /larger than 1000/);
    const r = await f(`http://127.0.0.1:${port}/echo`, { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
    expect(await r.text()).toBe('POST:{"a":1}');
  });
  it('rejects a non-http scheme', async () => {
    await rejects(createSafeFetch()('file:///etc/passwd'), /only https or http/);
  });
});

describe('outboundPolicyFromConfig', () => {
  it('private networks: allowed for lan, refused for internet, explicit value wins', () => {
    expect(outboundPolicyFromConfig({ exposure: 'lan' }).allowPrivate).toBe(true);
    expect(outboundPolicyFromConfig({ exposure: 'internet' }).allowPrivate).toBe(false);
    expect(outboundPolicyFromConfig({ exposure: 'internet', outbound: { allowPrivate: true, allowHosts: ['a'] } })).toEqual({ allowPrivate: true, allowHosts: ['a'] });
    setOutboundPolicy({});
  });
});
