import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';

export class MediaProbeError extends Error {
  /** @param {'FFPROBE_MISSING'|'PROBE_FAILED'|'PROBE_TIMEOUT'|'PROBE_BAD_OUTPUT'|'MEDIA_TOO_LONG'} code */
  constructor(code) { super(code); this.name = 'MediaProbeError'; this.code = code; }
}

const MAX_STREAMS = 32;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** Keeps only the few facts the core needs, with limits; ffprobe's own text never travels further. */
export function summarizeProbe(json) {
  if (!json || typeof json !== 'object' || !json.format || typeof json.format !== 'object') throw new MediaProbeError('PROBE_BAD_OUTPUT');
  const streams = (Array.isArray(json.streams) ? json.streams : []).slice(0, MAX_STREAMS).map((s) => ({
    type: ['video', 'audio', 'subtitle'].includes(s?.codec_type) ? s.codec_type : 'other',
    codec: String(s?.codec_name ?? '').slice(0, 40),
    width: num(s?.width), height: num(s?.height),
    channels: num(s?.channels), sampleRate: num(s?.sample_rate),
  }));
  return {
    container: String(json.format.format_name ?? '').slice(0, 80),
    durationSec: num(json.format.duration),
    bitRate: num(json.format.bit_rate),
    streams,
    hasVideo: streams.some((s) => s.type === 'video'),
    hasAudio: streams.some((s) => s.type === 'audio'),
  };
}

/**
 * The adapter for the external program `ffprobe` (part of ffmpeg). The core does not ship it: install it on the server and give
 * its full path. It is started without a shell, with the file as an argument, a time limit and a cap on its output; what it prints is
 * parsed as JSON and reduced to a small summary. Without it the media module still works, only without facts about the file.
 *
 * @param {{ path?: string|null, timeoutMs?: number, argsPrefix?: string[] }} [o] - `argsPrefix` goes before the arguments (a wrapper script in tests)
 */
export function createFfprobe({ path = null, timeoutMs = 15_000, argsPrefix = [] } = {}) {
  if (path !== null && (typeof path !== 'string' || !isAbsolute(path))) throw new TypeError('createFfprobe: path must be an absolute path');
  const run = (args) => new Promise((resolve, reject) => {
    if (!path) return reject(new MediaProbeError('FFPROBE_MISSING'));
    execFile(path, [...argsPrefix, ...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, env: { PATH: process.env.PATH ?? '', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? '' } : {}) }, shell: false }, (err, stdout) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(new MediaProbeError('FFPROBE_MISSING'));
        if (err.killed || err.signal) return reject(new MediaProbeError('PROBE_TIMEOUT'));
        return reject(new MediaProbeError('PROBE_FAILED'));
      }
      resolve(String(stdout));
    });
  });
  return {
    configured: path !== null,
    /** True when the program starts. */
    async available() {
      try { await run(['-version']); return true; } catch { return false; }
    },
    /**
     * @param {string} file - absolute path of a file the core stored itself
     * @param {{ maxDurationSec?: number }} [limits]
     */
    async probe(file, { maxDurationSec } = {}) {
      if (typeof file !== 'string' || !isAbsolute(file)) throw new TypeError('probe: an absolute file path is required');
      const out = await run(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', file]);
      let json;
      try { json = JSON.parse(out); } catch { throw new MediaProbeError('PROBE_BAD_OUTPUT'); }
      const info = summarizeProbe(json);
      if (maxDurationSec && info.durationSec !== null && info.durationSec > maxDurationSec) throw new MediaProbeError('MEDIA_TOO_LONG');
      return info;
    },
  };
}
