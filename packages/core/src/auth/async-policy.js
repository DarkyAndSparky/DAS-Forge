import { asyncDb } from '../database/async.js';
import { ensureSettingsTableAsync } from '../branding/company-branding.js';
import { checkPasswordPolicy } from './password-policy.js';
import { recentPasswordHashesAsync, passwordExpiredAsync } from './async.js';
import { createPasswordBlocklist } from './password-blocklist.js';
import { BUILTIN_WORDS, dictionaryHits, matchesDictionary } from './password-words.js';
import {
  DICTIONARY_WORDS_KEY, DICTIONARY_FILE_KEY, parseStoredWords, planAddWords, inspectBlocklistFile,
} from './password-dictionary.js';
import { PASSWORD_PROFILES, PASSWORD_POLICY_KEY, baseRules, effectiveRules, nextRules } from './password-policy-store.js';
import { keyList, isSealed, openWith, openSecret, sealSecret } from './secret-box.js';

/**
 * The password dictionary and the password policy over `asyncDb`, and the re-sealing of TOTP secrets (ADR-0010, step 7). The rules
 * themselves are the shared pure functions of password-dictionary.js and password-policy-store.js, so the two versions cannot
 * drift apart; here only the reading and writing of `app_settings` and the database checks are asynchronous.
 * Because reading the rules now takes a Promise, `check` and the dictionary lookups return Promises too.
 */

async function readSetting(a, key) {
  try {
    await ensureSettingsTableAsync(a);
    return (await a.get('SELECT value FROM app_settings WHERE key = ?', [key]))?.value ?? null;
  } catch { return null; }
}
async function writeSetting(a, key, value) {
  await ensureSettingsTableAsync(a);
  await a.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}
async function deleteSetting(a, key) {
  await ensureSettingsTableAsync(a);
  await a.run('DELETE FROM app_settings WHERE key = ?', [key]);
}

/** `createPasswordDictionary` for asynchronous code (every method that touched the database returns a Promise). */
export function createPasswordDictionaryAsync({ db, configFile = null }) {
  if (!db) throw new TypeError('createPasswordDictionaryAsync: db is required');
  const a = asyncDb(db);
  const lists = new Map();

  const words = async () => parseStoredWords(await readSetting(a, DICTIONARY_WORDS_KEY));

  async function addWords(input) {
    const before = await words();
    const plan = planAddWords(before, input);
    if (plan.next.length !== before.length) await writeSetting(a, DICTIONARY_WORDS_KEY, JSON.stringify(plan.next));
    return plan.result;
  }

  async function removeWord(word) {
    const { normalizeWord } = await import('./password-dictionary.js');
    const w = normalizeWord(word);
    const before = await words();
    if (!w || !before.includes(w)) return false;
    await writeSetting(a, DICTIONARY_WORDS_KEY, JSON.stringify(before.filter((x) => x !== w)));
    return true;
  }

  const filePath = async () => {
    const own = await readSetting(a, DICTIONARY_FILE_KEY);
    if (own) return { path: own, source: 'setting' };
    return configFile ? { path: configFile, source: 'config' } : { path: null, source: null };
  };

  async function setFile(path) {
    const info = await inspectBlocklistFile(path);
    await writeSetting(a, DICTIONARY_FILE_KEY, path);
    return info;
  }
  const clearFile = () => deleteSetting(a, DICTIONARY_FILE_KEY);

  async function fileState() {
    const { path, source } = await filePath();
    if (!path) return { path: null, source: null, ok: false };
    try {
      const { size } = await inspectBlocklistFile(path);
      return { path, source, ok: true, size };
    } catch (e) {
      return { path, source, ok: false, error: e.code ?? 'FILE_UNREADABLE' };
    }
  }

  async function fileHas(plain) {
    const { path } = await filePath();
    if (!path) return false;
    if (!lists.has(path)) { if (lists.size > 4) lists.clear(); lists.set(path, createPasswordBlocklist(path)); }
    return lists.get(path).has(plain);
  }

  const hasWord = async (plain) => matchesDictionary(plain, await words());

  async function inspect(plain) {
    const hits = dictionaryHits(plain, await words());
    const hasFile = Boolean((await filePath()).path);
    return { ...hits, file: hasFile ? await fileHas(plain) : null };
  }

  return { builtinCount: BUILTIN_WORDS.length, words, addWords, removeWord, fileState, setFile, clearFile, fileHas, hasWord, inspect };
}

/** `createPasswordPolicy` for asynchronous code; `get`, `set`, `reset`, `check`, `checkFull`, `isExpired` return Promises. */
export function createPasswordPolicyAsync({ db, config = {}, appName = '', blocklistFile = null } = {}) {
  if (!db) throw new TypeError('createPasswordPolicyAsync: db is required');
  const a = asyncDb(db);
  const dictionary = createPasswordDictionaryAsync({ db: a, configFile: blocklistFile });

  async function stored() {
    const raw = await readSetting(a, PASSWORD_POLICY_KEY);
    try { return raw ? JSON.parse(raw) : null; } catch { return null; }
  }
  const get = async () => effectiveRules(baseRules(config), await stored());

  async function set(input = {}) {
    const next = nextRules(await get(), input);
    await writeSetting(a, PASSWORD_POLICY_KEY, JSON.stringify(next));
    return get();
  }
  async function reset() {
    await deleteSetting(a, PASSWORD_POLICY_KEY);
    return get();
  }

  async function check(plain, { username, email, currentPassword, isAdmin = false } = {}) {
    const v = await get();
    const context = [username, typeof email === 'string' ? email.split('@')[0] : null, appName].filter(Boolean);
    return checkPasswordPolicy(plain, {
      minLength: isAdmin ? v.adminMinLength : v.minLength,
      maxLength: v.maxLength,
      requireClasses: v.requireClasses,
      username, currentPassword, context, words: await dictionary.words(),
    });
  }

  async function checkFull(plain, who = {}, { userId = null, verify = null, currentHash = null } = {}) {
    const r = await check(plain, who);
    if (typeof plain !== 'string') return r;
    const problems = [...r.problems];
    const v = await get();
    if (userId != null && verify && v.historyCount > 0) {
      const hashes = [...new Set([currentHash, ...(await recentPasswordHashesAsync(a, userId, v.historyCount))].filter(Boolean))];
      for (const h of hashes) {
        if ((await verify(h, plain)).valid) { problems.push('REUSED'); break; }
      }
    }
    if (await dictionary.fileHas(plain)) problems.push('LEAKED');
    return { ok: problems.length === 0, problems };
  }

  async function isExpired(userId) {
    return passwordExpiredAsync(a, userId, (await get()).maxAgeDays);
  }

  return { get, set, reset, check, checkFull, isExpired, dictionary, profiles: PASSWORD_PROFILES };
}

/** `sealExistingTotpSecrets` for asynchronous code: brings every TOTP secret to the CURRENT key. @returns {Promise<number>} rows changed */
export async function sealExistingTotpSecretsAsync(db, encryptionKey) {
  const keys = keyList(encryptionKey);
  if (keys.length === 0) return 0;
  const a = asyncDb(db);
  let n = 0;
  let unreadable = 0;
  for (const row of await a.all('SELECT authenticator_id, secret FROM totp_credentials')) {
    let plain;
    if (isSealed(row.secret)) {
      try {
        openWith(row.secret, keys[0]);
        continue;
      } catch {
        try { plain = openSecret(row.secret, keys); } catch { unreadable++; continue; }
      }
    } else {
      plain = row.secret;
    }
    await a.run('UPDATE totp_credentials SET secret = ? WHERE authenticator_id = ?', [sealSecret(plain, keys[0]), row.authenticator_id]);
    n++;
  }
  if (unreadable > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[das-forge] ${unreadable} TOTP secret(s) cannot be decrypted with the configured keys - add the old key to auth.previousTotpEncryptionKeys`);
  }
  return n;
}
