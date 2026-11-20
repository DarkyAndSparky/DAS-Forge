import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { detectMedia, parseRange, ingestMedia, serveMedia, createFfprobe, summarizeProbe, createMedia, MediaRejectedError, MediaProbeError, MediaDisabledError, DEFAULT_MEDIA_TYPES } from '../src/media/index.js';

const pad = (b, n = 64) => Buffer.concat([b, Buffer.alloc(Math.max(0, n - b.length))]);
const ftyp = (brand) => pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(8)]));
const SAMPLES = {
  mp4: ftyp('isom'), m4a: ftyp('M4A '), mov: ftyp('qt  '),
  webm: pad(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm')])),
  mkv: pad(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88]), Buffer.from('matroska')])),
  ogg: pad(Buffer.from('OggS\0\x02Opus')), ogv: pad(Buffer.from('OggS\0\x02\x01theora')),
  flac: pad(Buffer.from('fLaC')), wav: pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')])), avi: pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI LIST')])),
  mp3: pad(Buffer.from('ID3\x04\0\0')), aac: pad(Buffer.from([0xff, 0xf1, 0x50, 0x80])),
};

describe('detectMedia', () => {
  it('names each format by its first bytes', () => {
    for (const [type, buf] of Object.entries(SAMPLES)) expect(detectMedia(buf)?.type, type).toBe(type);
    expect(detectMedia(SAMPLES.mp4)).toMatchObject({ mime: 'video/mp4', kind: 'video' });
    expect(detectMedia(SAMPLES.m4a)).toMatchObject({ mime: 'audio/mp4', kind: 'audio' });
  });
  it('tells a bare MP3 frame from AAC and refuses the reserved version', () => {
    expect(detectMedia(pad(Buffer.from([0xff, 0xfb, 0x90, 0x00])))?.type).toBe('mp3');
    expect(detectMedia(pad(Buffer.from([0xff, 0xf1, 0x50, 0x80])))?.type).toBe('aac');
    expect(detectMedia(pad(Buffer.from([0xff, 0xe9, 0x90, 0x00])))).toBeNull();
  });
  it('does not take pictures, text, programs or short input for media', () => {
    expect(detectMedia(ftyp('heic'))).toBeNull();
    expect(detectMedia(ftyp('avif'))).toBeNull();
    expect(detectMedia(pad(Buffer.from('<html><script>alert(1)</script>')))).toBeNull();
    expect(detectMedia(pad(Buffer.from('MZ\x90\0')))).toBeNull();
    expect(detectMedia(pad(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')))).toBeNull();
    expect(detectMedia(Buffer.from('ftyp'))).toBeNull();
    expect(detectMedia('text')).toBeNull();
    expect(DEFAULT_MEDIA_TYPES).not.toContain('avi');
  });
});

describe('parseRange', () => {
  it('reads the three forms of one range', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-5000', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });
  it('says unsatisfiable when it starts past the end, and ignores what it cannot use', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-0', 0)).toBe('unsatisfiable');
    for (const h of [undefined, '', 'bytes=0-1,5-6', 'items=0-1', 'bytes=9-2', 'bytes=-', 'bytes=a-b', `bytes=${'9'.repeat(40)}-`, 'x'.repeat(500)]) expect(parseRange(h, 100), String(h).slice(0, 20)).toBeNull();
  });
});

const tmp = () => mkdtempSync(join(tmpdir(), 'media-'));
const body = (b) => Readable.from([b]);
const big = (n) => Buffer.concat([SAMPLES.mp4, Buffer.alloc(n - SAMPLES.mp4.length, 7)]);

describe('ingestMedia', () => {
  it('stores a file under a random name with its real type, and returns size and hash', async () => {
    const dir = tmp();
    const data = big(10_000);
    const r = await ingestMedia(body(data), { dir });
    expect(r).toMatchObject({ type: 'mp4', mime: 'video/mp4', kind: 'video', size: 10_000 });
    expect(r.name).toMatch(/^[0-9a-f-]{36}\.mp4$/);
    expect(r.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    expect(readFileSync(join(dir, r.name)).equals(data)).toBe(true);
    expect(readdirSync(dir)).toEqual([r.name]); // no temporary leftovers
  });
  it('works for small files and for input arriving in tiny pieces', async () => {
    const dir = tmp();
    const small = await ingestMedia(body(SAMPLES.mp3), { dir });
    expect(small.type).toBe('mp3');
    const pieces = Readable.from(Array.from(big(9000), (b) => Buffer.from([b])).reduce((acc, b, i) => { (i % 7 === 0 ? acc.push([b]) : acc.at(-1).push(b)); return acc; }, []).map((a) => Buffer.concat(a)));
    expect((await ingestMedia(pieces, { dir })).size).toBe(9000);
  });
  it('refuses a wrong type, an empty body and a type that is not allowed, and leaves nothing behind', async () => {
    const dir = tmp();
    const code = async (src, o = {}) => { try { await ingestMedia(src, { dir, ...o }); return 'stored'; } catch (e) { return e instanceof MediaRejectedError ? e.code : String(e); } };
    expect(await code(body(Buffer.from('<?php system($_GET[0]); ?>'.repeat(200))))).toBe('MEDIA_TYPE_NOT_ALLOWED');
    expect(await code(body(Buffer.alloc(0)))).toBe('MEDIA_EMPTY');
    expect(await code(body(SAMPLES.mkv))).toBe('MEDIA_TYPE_NOT_ALLOWED'); // opt-in format
    expect(await ingestMedia(body(SAMPLES.mkv), { dir, allowedTypes: ['mkv'] })).toMatchObject({ type: 'mkv' });
    expect(readdirSync(dir).length).toBe(1);
  });
  it('stops at the size limit and removes the partial file', async () => {
    const dir = tmp();
    await expect(ingestMedia(body(big(50_000)), { dir, maxBytes: 20_000 })).rejects.toThrow('MEDIA_TOO_LARGE');
    expect(readdirSync(dir)).toEqual([]);
    await expect(ingestMedia(null, {})).rejects.toThrow(TypeError);
  });
  it('a source that fails half way leaves nothing behind', async () => {
    const dir = tmp();
    const failing = new Readable({ read() { this.push(big(6000)); this.destroy(new Error('connection lost')); } });
    await expect(ingestMedia(failing, { dir })).rejects.toThrow('connection lost');
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('serveMedia over real HTTP', () => {
  async function setup() {
    const dir = tmp();
    const data = big(1000);
    const { name } = await ingestMedia(body(data), { dir });
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      serveMedia(req, res, dir, u.searchParams.get('n') ?? name, { downloadName: 'Лекция 1.mp4' }).catch(() => res.end());
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/`;
    return { data, name, url, close: () => new Promise((r) => server.close(r)) };
  }

  it('sends the whole file with the headers a player and a browser need', async () => {
    const s = await setup();
    const r = await fetch(s.url);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('video/mp4');
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toContain('sandbox');
    expect(r.headers.get('content-length')).toBe('1000');
    expect(r.headers.get('content-disposition')).toContain("filename*=UTF-8''%D0%9B%D0%B5%D0%BA%D1%86%D0%B8%D1%8F%201.mp4");
    expect(Buffer.from(await r.arrayBuffer()).equals(s.data)).toBe(true);
    await s.close();
  });

  it('answers a range with 206 and exactly those bytes, so the player can seek', async () => {
    const s = await setup();
    const r = await fetch(s.url, { headers: { Range: 'bytes=100-199' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(r.headers.get('content-length')).toBe('100');
    expect(Buffer.from(await r.arrayBuffer()).equals(s.data.subarray(100, 200))).toBe(true);
    const tail = await fetch(s.url, { headers: { Range: 'bytes=-10' } });
    expect(tail.headers.get('content-range')).toBe('bytes 990-999/1000');
    await tail.arrayBuffer();
    await s.close();
  });

  it('416 past the end, whole file for several ranges, HEAD without a body', async () => {
    const s = await setup();
    const past = await fetch(s.url, { headers: { Range: 'bytes=5000-' } });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe('bytes */1000');
    const multi = await fetch(s.url, { headers: { Range: 'bytes=0-1,5-6' } });
    expect(multi.status).toBe(200);
    expect((await multi.arrayBuffer()).byteLength).toBe(1000);
    const head = await fetch(s.url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('1000');
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    await s.close();
  });

  it('304 for the same validator; If-Range with another validator gives the whole file', async () => {
    const s = await setup();
    const first = await fetch(s.url);
    const etag = first.headers.get('etag');
    await first.arrayBuffer();
    const again = await fetch(s.url, { headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);
    const stale = await fetch(s.url, { headers: { Range: 'bytes=0-9', 'If-Range': '"other"' } });
    expect(stale.status).toBe(200);
    await stale.arrayBuffer();
    const fresh = await fetch(s.url, { headers: { Range: 'bytes=0-9', 'If-Range': etag } });
    expect(fresh.status).toBe(206);
    await fresh.arrayBuffer();
    await s.close();
  });

  it('404 for any name that is not one the core stored, 405 for other methods', async () => {
    const s = await setup();
    for (const n of ['../../etc/passwd', 'x.mp4', '..%2f..%2fetc%2fpasswd', 'a'.repeat(36) + '.mp4', `${s.name.replace('.mp4', '')}.exe`, '00000000-0000-0000-0000-000000000000.mp4']) {
      const r = await fetch(`${s.url}?n=${encodeURIComponent(n)}`);
      expect(r.status, n).toBe(404);
      await r.arrayBuffer();
    }
    const post = await fetch(s.url, { method: 'POST', body: 'x' });
    expect(post.status).toBe(405);
    await post.arrayBuffer();
    await s.close();
  });
});

describe('ffprobe adapter', () => {
  const script = (js) => { const f = join(tmp(), 'fake-ffprobe.mjs'); writeFileSync(f, js); return f; };
  const make = (js, o = {}) => createFfprobe({ path: process.execPath, argsPrefix: [script(js)], ...o });

  it('summarizes the program\'s JSON and keeps only the few facts', async () => {
    const p = make(`console.log(JSON.stringify({ format: { format_name: 'mov,mp4', duration: '12.5', bit_rate: '800000', tags: { secret: 'x' } }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, extra: 'no' }, { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }] }))`);
    const info = await p.probe(join(tmp(), 'f.mp4'));
    expect(info).toEqual({ container: 'mov,mp4', durationSec: 12.5, bitRate: 800000, hasVideo: true, hasAudio: true, streams: [{ type: 'video', codec: 'h264', width: 1280, height: 720, channels: null, sampleRate: null }, { type: 'audio', codec: 'aac', width: null, height: null, channels: 2, sampleRate: 48000 }] });
    expect(await p.available()).toBe(true);
  });
  it('refuses a file that is too long, bad output, a failing program, a slow one and a missing one', async () => {
    const f = join(tmp(), 'f.mp4');
    const code = async (p, o) => { try { await p.probe(f, o); return 'ok'; } catch (e) { return e instanceof MediaProbeError ? e.code : String(e); } };
    expect(await code(make(`console.log(JSON.stringify({ format: { duration: '9999' }, streams: [] }))`), { maxDurationSec: 60 })).toBe('MEDIA_TOO_LONG');
    expect(await code(make(`console.log('not json')`))).toBe('PROBE_BAD_OUTPUT');
    expect(await code(make(`console.log('{}')`))).toBe('PROBE_BAD_OUTPUT');
    expect(await code(make(`process.exit(1)`))).toBe('PROBE_FAILED');
    expect(await code(make(`setTimeout(() => {}, 60000)`, { timeoutMs: 300 }))).toBe('PROBE_TIMEOUT');
    expect(await code(createFfprobe({ path: join(tmp(), 'no-such-program') }))).toBe('FFPROBE_MISSING');
    expect(await code(createFfprobe())).toBe('FFPROBE_MISSING');
    expect(await createFfprobe().available()).toBe(false);
  });
  it('needs absolute paths', async () => {
    expect(() => createFfprobe({ path: 'ffprobe' })).toThrow(TypeError);
    await expect(createFfprobe({ path: process.execPath }).probe('relative.mp4')).rejects.toThrow(TypeError);
    expect(() => summarizeProbe(null)).toThrow(MediaProbeError);
  });
});

describe('createMedia (the module, off by default)', () => {
  it('fails every call with MEDIA_DISABLED unless it is switched on', async () => {
    const m = createMedia({});
    expect(m.enabled).toBe(false);
    await expect(m.ingest(body(SAMPLES.mp3))).rejects.toThrow(MediaDisabledError);
    expect(() => m.serve({}, {}, 'x')).toThrow(MediaDisabledError);
    await expect(m.remove('x')).rejects.toThrow(MediaDisabledError);
  });
  it('needs a directory when switched on', async () => {
    await expect(createMedia({ media: { enabled: true } }).ingest(body(SAMPLES.mp3))).rejects.toThrow(TypeError);
  });
  it('stores, examines with the program, removes; a file the program rejects is deleted', async () => {
    const dir = tmp();
    const f = join(tmp(), 'fp.mjs');
    writeFileSync(f, `console.log(JSON.stringify({ format: { format_name: 'mp3', duration: process.env.DUR ?? '30' }, streams: [{ codec_type: 'audio', codec_name: 'mp3' }] }))`);
    const m = createMedia({ media: { enabled: true, dir, maxDurationSec: 60, ffprobePath: process.execPath } });
    m.ffprobe.probe = async (file, lim) => createFfprobe({ path: process.execPath, argsPrefix: [f] }).probe(file, lim);
    const r = await m.ingest(body(SAMPLES.mp3));
    expect(r.info).toMatchObject({ hasAudio: true, durationSec: 30 });
    expect(existsSync(join(dir, r.name))).toBe(true);
    expect(await m.remove(r.name)).toBe(true);
    expect(await m.remove('../x')).toBe(false);
    const strict = createMedia({ media: { enabled: true, dir, maxDurationSec: 10, ffprobePath: process.execPath } });
    strict.ffprobe.probe = async (file, lim) => createFfprobe({ path: process.execPath, argsPrefix: [f] }).probe(file, lim);
    await expect(strict.ingest(body(SAMPLES.mp3))).rejects.toThrow('MEDIA_TOO_LONG');
    expect(readdirSync(dir)).toEqual([]);
  });
  it('without a program it still stores, with no facts about the file', async () => {
    const dir = tmp();
    const r = await createMedia({ media: { enabled: true, dir } }).ingest(body(SAMPLES.ogg));
    expect(r).toMatchObject({ type: 'ogg', info: null });
  });
});
