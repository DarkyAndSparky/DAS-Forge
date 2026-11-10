import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { liveConsoleSupported, startLiveConsole, FOOTER_HEIGHT } from '../src/console/live-console.js';

function fakeTerm({ rows = 40, columns = 120 } = {}) {
  const written = [];
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, rows, columns, write: (c) => { written.push(String(c)); return true; } });
  const stderr = Object.assign(new EventEmitter(), { isTTY: true, write: (c) => { written.push(`ERR:${c}`); return true; } });
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, raw: false, setRawMode(v) { this.raw = v; }, setEncoding() {}, resume() {}, pause() {} });
  const proc = new EventEmitter();
  return { stdout, stderr, stdin, proc, written, text: () => written.join('') };
}

describe('live console (terminal only)', () => {
  it('is only for a real, big enough terminal that nobody switched off', () => {
    const t = fakeTerm();
    expect(liveConsoleSupported({ stdout: t.stdout, stdin: t.stdin, env: {} })).toBe(true);
    expect(liveConsoleSupported({ stdout: t.stdout, stdin: t.stdin, env: { DAS_CONSOLE: 'plain' } })).toBe(false);
    expect(liveConsoleSupported({ stdout: t.stdout, stdin: t.stdin, env: { CI: 'true' } })).toBe(false);
    expect(liveConsoleSupported({ stdout: { ...t.stdout, isTTY: false }, stdin: t.stdin, env: {} })).toBe(false);
    expect(liveConsoleSupported({ stdout: fakeTerm({ rows: 20 }).stdout, stdin: t.stdin, env: {} })).toBe(false);
    expect(liveConsoleSupported({ stdout: fakeTerm({ columns: 80 }).stdout, stdin: t.stdin, env: {} })).toBe(false);
  });

  it('keeps the lower part fixed: scroll region above it, lettering, "=" and a prompt', () => {
    const t = fakeTerm({ rows: 40 });
    const c = startLiveConsole({ ...t });
    const s = t.text();
    expect(s).toContain(`\x1b[1;${40 - FOOTER_HEIGHT}r`);
    expect(s).toContain('MMVVFMMMM');
    expect(s).toContain('> ');
    expect(t.stdin.raw).toBe(true);
    c.stop();
  });

  it('routes what the process prints above the fixed part, and stdout/stderr alike', () => {
    const t = fakeTerm({ rows: 40 });
    const realOut = t.stdout.write;
    const c = startLiveConsole({ ...t });
    t.written.length = 0;
    t.stdout.write('[00:15:25] INFO: GET / 302\n');
    t.stderr.write('warn line\n');
    const s = t.text();
    expect(s).toContain(`\x1b7\x1b[${40 - FOOTER_HEIGHT};1H\n[00:15:25] INFO: GET / 302\x1b8`);
    expect(s).toContain('warn line');
    c.stop();
    expect(t.stdout.write).toBe(realOut); // given back
  });

  it('runs a typed command and shows its answer; unknown, missing slash and errors do not break it', async () => {
    const t = fakeTerm();
    const c = startLiveConsole({ ...t, commands: { health: { description: 'h', run: () => ['status: ok', 'database: ok'] }, boom: { description: 'b', run: () => { throw new Error('nope'); } } } });
    t.written.length = 0;
    await c.onData('/health\r');
    expect(t.text()).toContain('status: ok');
    expect(t.text()).toContain('database: ok');
    t.written.length = 0;
    await c.run('/help');
    expect(t.text()).toContain('/health');
    expect(t.text()).toContain('/stop');
    t.written.length = 0;
    await c.run('/nothing');
    expect(t.text()).toContain('/nothing');
    await c.run('hello');
    expect(t.text()).toContain('начинаются с');
    await c.run('/boom');
    expect(t.text()).toContain('nope');
    await c.run('/constructor'); // prototype names are not commands
    expect(t.text()).toContain('unknown command: /constructor');
    c.stop();
  });

  it('Backspace edits the line and /stop or Ctrl+C call onStop once per use', async () => {
    const t = fakeTerm();
    let stops = 0;
    const c = startLiveConsole({ ...t, onStop: () => { stops += 1; } });
    await c.onData('/stx');
    await c.onData('\x7f');
    await c.onData('op\r');
    expect(stops).toBe(1);
    await c.onData('\x03');
    expect(stops).toBe(2);
    c.stop();
  });

  it('stop() gives the terminal back: region reset, raw mode off, writes pass through', () => {
    const t = fakeTerm();
    const c = startLiveConsole({ ...t });
    t.written.length = 0;
    c.stop();
    expect(t.text()).toContain('\x1b[r');
    expect(t.stdin.raw).toBe(false);
    t.written.length = 0;
    t.stdout.write('plain\n');
    expect(t.text()).toBe('plain\n');
    c.stop(); // twice is harmless
  });
});
