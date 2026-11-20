import { isAbsolute } from 'node:path';
import { open, stat } from 'node:fs/promises';
import { ensureSettingsTable } from '../branding/company-branding.js';
import { createPasswordBlocklist } from './password-blocklist.js';
import { BUILTIN_WORDS, dictionaryHits, matchesDictionary } from './password-words.js';

const WORDS_KEY = 'password_custom_words';
const FILE_KEY = 'password_blocklist_file';
export const MAX_CUSTOM_WORDS = 5000;
export const MAX_WORD_LENGTH = 128;
const HASH_LINE = /^[0-9A-Fa-f]{40}(:\d{1,12})?$/;

export class PasswordDictionaryError extends Error {
  /** @param {'WORD_INVALID'|'TOO_MANY_WORDS'|'FILE_PATH_INVALID'|'FILE_NOT_FOUND'|'FILE_UNREADABLE'|'FILE_FORMAT_INVALID'} code */
  constructor(code) { super(code); this.name = 'PasswordDictionaryError'; this.code = code; }
}

/** One word as it is kept: trimmed, lower case. Anything with a control character, or too short or long, is refused (null). */
export function normalizeWord(raw) {
  if (typeof raw !== 'string') return null;
  const w = raw.normalize('NFKC').trim().toLowerCase();
  if (w.length < 4 || w.length > MAX_WORD_LENGTH || /[\p{Cc}\p{Cf}]/u.test(w)) return null;
  return w;
}

/** The custom words as stored (a JSON array in a settings row); a missing or damaged row reads as an empty list. */
export function parseStoredWords(raw) {
  if (raw == null) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return [...new Set(v.map(normalizeWord).filter(Boolean))].sort();
  } catch { return []; }
}

/** What adding `input` (array, or text split at line ends, commas, semicolons) to `before` would give; throws TOO_MANY_WORDS. */
export function planAddWords(before, input) {
  const items = Array.isArray(input) ? input : String(input ?? '').split(/[\r\n,;]+/);
  const set = new Set(before);
  let invalid = 0;
  let skipped = 0;
  for (const item of items) {
    if (typeof item === 'string' && item.trim() === '') continue;
    const w = normalizeWord(item);
    if (!w) { invalid += 1; continue; }
    if (set.has(w)) { skipped += 1; continue; }
    set.add(w);
  }
  if (set.size > MAX_CUSTOM_WORDS) throw new PasswordDictionaryError('TOO_MANY_WORDS');
  const next = [...set].sort();
  return { next, result: { added: next.length - before.length, skipped, invalid, total: next.length } };
}

export { WORDS_KEY as DICTIONARY_WORDS_KEY, FILE_KEY as DICTIONARY_FILE_KEY };

/** Looks at the head and tail of a file: it must read like a list of `SHA1:count` lines in ascending order. */
export async function inspectBlocklistFile(path) {
  if (typeof path !== 'string' || path.length > 1024 || /[\0\r\n]/.test(path) || !isAbsolute(path)) throw new PasswordDictionaryError('FILE_PATH_INVALID');
  let st;
  try { st = await stat(path); } catch { throw new PasswordDictionaryError('FILE_NOT_FOUND'); }
  if (!st.isFile()) throw new PasswordDictionaryError('FILE_NOT_FOUND');
  if (st.size < 41) throw new PasswordDictionaryError('FILE_FORMAT_INVALID');
  let fh;
  try {
    fh = await open(path, 'r');
    const chunk = 8192;
    const sample = async (pos, dropFirst) => {
      const buf = Buffer.alloc(Math.min(chunk, st.size - pos));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      let lines = buf.toString('latin1', 0, bytesRead).split('\n').map((l) => l.replace(/\r$/, ''));
      if (dropFirst) lines = lines.slice(1);
      lines = lines.slice(0, -1); // the last piece may be cut in the middle
      return lines.filter((l) => l !== '');
    };
    const head = await sample(0, false);
    const tail = st.size > chunk ? await sample(st.size - chunk, true) : [];
    const all = [...head, ...tail];
    if (head.length === 0 || all.some((l) => !HASH_LINE.test(l))) throw new PasswordDictionaryError('FILE_FORMAT_INVALID');
    for (const part of [head, tail]) {
      for (let i = 1; i < part.length; i += 1) if (part[i].slice(0, 40).toUpperCase() < part[i - 1].slice(0, 40).toUpperCase()) throw new PasswordDictionaryError('FILE_FORMAT_INVALID');
    }
    if (head.length && tail.length && tail[0].slice(0, 40).toUpperCase() < head[head.length - 1].slice(0, 40).toUpperCase()) throw new PasswordDictionaryError('FILE_FORMAT_INVALID');
    return { size: st.size };
  } catch (e) {
    if (e instanceof PasswordDictionaryError) throw e;
    throw new PasswordDictionaryError('FILE_UNREADABLE');
  } finally { await fh?.close().catch(() => {}); }
}

/**
 * The password dictionary, three layers that add up: the built-in list (cannot be switched off), the administrator's own words
 * (kept in `app_settings`, so no restart) and a large leaked-password file in the "Pwned Passwords" format (searched on disk;
 * the path comes from the administrator's setting, else from the configuration).
 *
 * @param {{ db: object, configFile?: string|null }} o
 */
export function createPasswordDictionary({ db, configFile = null }) {
  if (!db) throw new TypeError('createPasswordDictionary: db is required');
  const lists = new Map(); // file path -> blocklist (the object only keeps the path)

  const readSetting = (key) => {
    try {
      ensureSettingsTable(db);
      return db.get(`SELECT value FROM app_settings WHERE key = ?`, [key])?.value ?? null;
    } catch { return null; }
  };
  const writeSetting = (key, value) => {
    ensureSettingsTable(db);
    db.run(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
  };

  /** @returns {string[]} sorted; a damaged row reads as an empty list */
  function words() {
    return parseStoredWords(readSetting(WORDS_KEY));
  }

  /**
   * Adds words (an array, or text with one word per line or separated by commas).
   * @returns {{ added: number, skipped: number, invalid: number, total: number }}
   */
  function addWords(input) {
    const before = words();
    const plan = planAddWords(before, input);
    if (plan.next.length !== before.length) writeSetting(WORDS_KEY, JSON.stringify(plan.next));
    return plan.result;
  }

  /** @returns {boolean} whether the word was there */
  function removeWord(word) {
    const w = normalizeWord(word);
    const before = words();
    if (!w || !before.includes(w)) return false;
    writeSetting(WORDS_KEY, JSON.stringify(before.filter((x) => x !== w)));
    return true;
  }

  const filePath = () => {
    const own = readSetting(FILE_KEY);
    if (own) return { path: own, source: 'setting' };
    return configFile ? { path: configFile, source: 'config' } : { path: null, source: null };
  };

  /** Connects a file (checked first). The setting wins over the configuration. */
  async function setFile(path) {
    const info = await inspectBlocklistFile(path);
    writeSetting(FILE_KEY, path);
    return info;
  }

  /** Drops the administrator's file; the configured one (if any) applies again. */
  function clearFile() {
    ensureSettingsTable(db);
    db.run(`DELETE FROM app_settings WHERE key = ?`, [FILE_KEY]);
  }

  /** @returns {Promise<{ path: string|null, source: 'setting'|'config'|null, ok: boolean, size?: number, error?: string }>} */
  async function fileState() {
    const { path, source } = filePath();
    if (!path) return { path: null, source: null, ok: false };
    try {
      const { size } = await inspectBlocklistFile(path);
      return { path, source, ok: true, size };
    } catch (e) {
      return { path, source, ok: false, error: e.code ?? 'FILE_UNREADABLE' };
    }
  }

  async function fileHas(plain) {
    const { path } = filePath();
    if (!path) return false;
    if (!lists.has(path)) { if (lists.size > 4) lists.clear(); lists.set(path, createPasswordBlocklist(path)); }
    return lists.get(path).has(plain);
  }

  /** Built-in or own word (no disk): used by the synchronous password check. */
  const hasWord = (plain) => matchesDictionary(plain, words());

  /**
   * For the "check a password" tool: which layer catches it. The password is only hashed or compared, never kept or logged.
   * @returns {Promise<{ builtin: boolean, custom: boolean, file: boolean|null }>}
   */
  async function inspect(plain) {
    const hits = dictionaryHits(plain, words());
    const hasFile = Boolean(filePath().path);
    return { ...hits, file: hasFile ? await fileHas(plain) : null };
  }

  return { builtinCount: BUILTIN_WORDS.length, words, addWords, removeWord, fileState, setFile, clearFile, fileHas, hasWord, inspect };
}
