import { DAS_FORGE_WORDMARK } from '../ui/ascii-brand.js';

/**
 * A live console for a server started in a terminal window: the log scrolls in the upper part, the lower part stays
 * in place - the "DAS FORGE" lettering, a line of "=", a few lines where a command's answer appears, and a prompt
 * where `/health`, `/status`, `/help`, `/stop` can be typed.
 *
 * It only exists in a real terminal that is big enough (see `liveConsoleSupported`); in Docker, a service, a pipe or
 * with DAS_CONSOLE=plain the server writes exactly what it wrote before. Everything is plain ANSI (scroll region +
 * cursor moves), nothing is installed. Output of the process (stdout and stderr) is routed above the fixed part.
 */

export const OUTPUT_LINES = 5;
const WORDMARK_HEIGHT = DAS_FORGE_WORDMARK.length;
/** Lines the fixed part takes: lettering, "=", answer lines, prompt. */
export const FOOTER_HEIGHT = WORDMARK_HEIGHT + 1 + OUTPUT_LINES + 1;
const MIN_LOG_LINES = 8;
const MIN_COLUMNS = 100;
const INDENT = '  ';
const ESC = '\x1b';
const HISTORY = 30;

/** True when stdin and stdout are a terminal, big enough for the fixed part and a few lines of log, and nobody switched it off. */
export function liveConsoleSupported({ stdout = process.stdout, stdin = process.stdin, env = process.env } = {}) {
  if (env.DAS_CONSOLE === 'plain' || env.CI) return false;
  if (!stdout?.isTTY || !stdin?.isTTY || typeof stdin.setRawMode !== 'function') return false;
  return (stdout.rows ?? 0) >= FOOTER_HEIGHT + MIN_LOG_LINES && (stdout.columns ?? 0) >= MIN_COLUMNS;
}

const clip = (s, width) => ([...String(s)].length > width ? `${[...String(s)].slice(0, Math.max(0, width - 1)).join('')}…` : String(s));

/**
 * Starts the live console. Returns `{ stop, run }`: `stop()` gives the terminal back (called on exit by itself too),
 * `run(line)` is what a typed line does (exposed for tests).
 * @param {object} o
 * @param {Record<string, {description: string, run: (args: string[]) => (string|string[]|Promise<string|string[]>)}>} [o.commands] - by name without the slash; `help`, `clear` and `stop` exist always
 * @param {() => void} [o.onStop] - what `/stop` and Ctrl+C do; default: the same as Ctrl+C would (SIGINT handlers, so the graceful shutdown runs)
 * @param {*} [o.stdout] @param {*} [o.stdin] @param {NodeJS.Process} [o.proc]
 */
export function startLiveConsole({ commands = {}, onStop, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, proc = process } = {}) {
  const rawOut = stdout.write;
  const rawErr = stderr.write;
  const origOut = rawOut.bind(stdout);
  const origErr = rawErr.bind(stderr);
  const stopFn = onStop ?? (() => proc.emit('SIGINT', 'SIGINT'));
  const all = {
    help: { description: 'список команд / list of commands', run: () => Object.entries(all).map(([n, c]) => `/${n.padEnd(8)} ${c.description}`) },
    ...commands,
    clear: { description: 'очистить ответ / clear the answer', run: () => [] },
    stop: { description: 'остановить сервер / stop the server', run: () => { stopFn(); return 'Останавливаю… / stopping…'; } },
  };

  let rows = stdout.rows;
  let cols = stdout.columns;
  let output = ['Введите /help / type /help'];
  let typed = '';
  const history = [];
  let hIndex = -1;
  let active = true;
  let busy = false;

  const bottom = () => rows - FOOTER_HEIGHT; // last row of the scrolling part

  function draw() {
    const top = rows - FOOTER_HEIGHT + 1;
    const out = [];
    const put = (r, text) => out.push(`${ESC}[${r};1H${ESC}[2K${text}`);
    DAS_FORGE_WORDMARK.forEach((l, i) => put(top + i, INDENT + l));
    put(top + WORDMARK_HEIGHT, INDENT + '='.repeat(Math.max(1, Math.min(cols - 4, Math.max(...DAS_FORGE_WORDMARK.map((l) => l.length))))));
    const shown = output.length > OUTPUT_LINES ? [...output.slice(0, OUTPUT_LINES - 1), `… (+${output.length - OUTPUT_LINES + 1})`] : output;
    for (let i = 0; i < OUTPUT_LINES; i++) put(top + WORDMARK_HEIGHT + 1 + i, shown[i] === undefined ? '' : INDENT + clip(shown[i], cols - 4));
    const promptText = `${INDENT}> `;
    const room = cols - promptText.length - 1;
    const visible = [...typed].slice(-room).join('');
    put(rows, promptText + visible);
    out.push(`${ESC}[${rows};${promptText.length + [...visible].length + 1}H`);
    origOut(out.join(''));
  }

  function setRegion() {
    origOut(`${ESC}[1;${bottom()}r`);
  }

  // Everything the process prints goes above the fixed part: scroll the upper part by one line, write there, come back to the prompt.
  const route = (orig) => (chunk, encoding, cb) => {
    if (!active) return orig(chunk, encoding, cb);
    const text = (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')).replace(/\r?\n$/, '');
    const callback = typeof encoding === 'function' ? encoding : cb;
    return orig(`${ESC}7${ESC}[${bottom()};1H\n${text}${ESC}8`, 'utf8', callback);
  };

  async function run(line) {
    const text = String(line).trim();
    if (!text) return;
    history.unshift(text);
    history.length = Math.min(history.length, HISTORY);
    hIndex = -1;
    if (!text.startsWith('/')) { output = ['Команды начинаются с «/», список: /help / commands start with "/", list: /help']; return; }
    const [name, ...args] = text.slice(1).split(/\s+/);
    const cmd = Object.hasOwn(all, name) ? all[name] : null;
    if (!cmd) { output = [`Нет такой команды / unknown command: /${name}`]; return; }
    busy = true;
    try {
      const r = await cmd.run(args);
      output = Array.isArray(r) ? r : r === undefined ? [] : String(r).split('\n');
    } catch (err) {
      output = [`Ошибка / error: ${err?.message ?? err}`];
    } finally {
      busy = false;
    }
  }

  async function onData(data) {
    let s = String(data);
    if (s.includes('\x03')) { void run('/stop'); draw(); return; } // Ctrl+C
    if (/\x1b\[A/.test(s)) { if (hIndex + 1 < history.length) { hIndex += 1; typed = history[hIndex]; } draw(); return; }
    if (/\x1b\[B/.test(s)) { hIndex = Math.max(-1, hIndex - 1); typed = hIndex >= 0 ? history[hIndex] : ''; draw(); return; }
    s = s.replace(/\x1b\[[0-9;]*[A-Za-z~]/g, '');
    for (const ch of s) {
      if (ch === '\r' || ch === '\n') {
        const line = typed; typed = '';
        if (!busy) { await run(line); }
      } else if (ch === '\x7f' || ch === '\b') typed = [...typed].slice(0, -1).join('');
      else if (ch >= ' ' && ch !== '\x7f') typed += ch;
    }
    draw();
  }

  function onResize() {
    rows = stdout.rows; cols = stdout.columns;
    if (rows < FOOTER_HEIGHT + MIN_LOG_LINES || cols < MIN_COLUMNS) { stop(); return; }
    setRegion();
    draw();
  }

  function stop() {
    if (!active) return;
    active = false;
    stdout.removeListener?.('resize', onResize);
    stdin.removeListener?.('data', onData);
    try { stdin.setRawMode(false); stdin.pause(); } catch { /* the terminal is gone */ }
    origOut(`${ESC}[r${ESC}[${rows};1H\n`);
  }

  origOut('\n'.repeat(FOOTER_HEIGHT)); // push what is on screen up, so nothing is covered
  setRegion();
  draw();
  stdout.write = route(origOut);
  stderr.write = route(origErr);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.on('data', onData);
  stdin.resume();
  stdout.on('resize', onResize);
  proc.once('exit', () => { stdout.write = rawOut; stderr.write = rawErr; stop(); });

  return { stop: () => { stdout.write = rawOut; stderr.write = rawErr; stop(); }, run: async (l) => { await run(l); draw(); }, onData };
}
