import { PasswordDictionaryError, MAX_CUSTOM_WORDS } from '../auth/password-dictionary.js';
import { logAsync } from '../audit/async.js';
import { contextFromRequest } from '../audit/context.js';
import { readForm } from './sections.js';
import { pageParams, pagerFor } from './paging.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const DICT_TEXTS = {
  ru: {
    dictTitle: 'Словарь паролей',
    dictText: 'Три слоя складываются. Встроенный список нельзя отключить: он ловит и «замаскированные» варианты (Password2024!, P@ssw0rd). Свои слова добавляются здесь и действуют сразу. Большой файл утёкших паролей (формат Pwned Passwords) подключается по пути на сервере и ищется на диске, наружу ничего не уходит.',
    dictBuiltin: 'Встроенный список', dictBuiltinN: 'слов',
    dictFile: 'Файл утёкших паролей', dictNoFile: 'не подключён', dictFileOk: 'подключён и проверен', dictFileBad: 'не читается',
    dictFileSource: 'Откуда', dictSrcSetting: 'настройка администратора', dictSrcConfig: 'конфигурация (auth.passwordBlocklistFile)', dictSize: 'Размер, байт',
    dictFilePath: 'Полный путь к файлу на сервере', dictConnect: 'Подключить', dictDisconnect: 'Отключить файл',
    dictOwn: 'Свои слова', dictOwnHint: 'Слово от 4 знаков; регистр не важен. Можно несколько: по одному в строке или через запятую.',
    dictAdd: 'Добавить', dictRemove: 'Убрать', dictWord: 'Слово', dictEmpty: 'Своих слов пока нет.', dictTotalMax: 'Не больше',
    dictCheck: 'Проверить пароль', dictCheckHint: 'Пароль только сравнивается, нигде не сохраняется и не пишется в журнал.', dictCheckBtn: 'Проверить',
    dictRes: 'Результат', dictFound: 'найден', dictNotFound: 'не найден', dictNoFileShort: 'файл не подключён', dictAnyBad: 'Такой пароль будет отклонён.', dictAllOk: 'Словари такой пароль не отклоняют.',
    dictAdded: 'Добавлено', dictSkipped: 'уже были', dictInvalid: 'не подошли',
    e_WORD_INVALID: 'Слово должно быть от 4 до 128 знаков без управляющих символов.', e_TOO_MANY_WORDS: 'Слишком много своих слов.',
    e_FILE_PATH_INVALID: 'Нужен полный (абсолютный) путь к файлу.', e_FILE_NOT_FOUND: 'Файл не найден на сервере.', e_FILE_UNREADABLE: 'Файл не читается.',
    e_FILE_FORMAT_INVALID: 'Это не список «SHA1:число», отсортированный по хэшу (формат Pwned Passwords, «ordered by hash»).',
  },
  en: {
    dictTitle: 'Password dictionary',
    dictText: 'Three layers add up. The built-in list cannot be switched off: it also catches disguised forms (Password2024!, P@ssw0rd). Your own words are added here and apply at once. A large leaked-password file (Pwned Passwords format) is connected by its path on the server and searched on disk; nothing leaves the machine.',
    dictBuiltin: 'Built-in list', dictBuiltinN: 'words',
    dictFile: 'Leaked-password file', dictNoFile: 'not connected', dictFileOk: 'connected and checked', dictFileBad: 'cannot be read',
    dictFileSource: 'Source', dictSrcSetting: 'administrator setting', dictSrcConfig: 'configuration (auth.passwordBlocklistFile)', dictSize: 'Size, bytes',
    dictFilePath: 'Full path of the file on the server', dictConnect: 'Connect', dictDisconnect: 'Disconnect the file',
    dictOwn: 'Own words', dictOwnHint: 'A word of 4 characters or more; case does not matter. Several at once: one per line or separated by commas.',
    dictAdd: 'Add', dictRemove: 'Remove', dictWord: 'Word', dictEmpty: 'No own words yet.', dictTotalMax: 'At most',
    dictCheck: 'Check a password', dictCheckHint: 'The password is only compared; it is never stored or written to the log.', dictCheckBtn: 'Check',
    dictRes: 'Result', dictFound: 'found', dictNotFound: 'not found', dictNoFileShort: 'no file connected', dictAnyBad: 'Such a password will be refused.', dictAllOk: 'The dictionaries do not refuse such a password.',
    dictAdded: 'Added', dictSkipped: 'already there', dictInvalid: 'did not fit',
    e_WORD_INVALID: 'A word is 4 to 128 characters with no control characters.', e_TOO_MANY_WORDS: 'Too many own words.',
    e_FILE_PATH_INVALID: 'A full (absolute) path is needed.', e_FILE_NOT_FOUND: 'The file was not found on the server.', e_FILE_UNREADABLE: 'The file cannot be read.',
    e_FILE_FORMAT_INVALID: 'This is not a "SHA1:count" list sorted by hash (Pwned Passwords format, "ordered by hash").',
  },
};

/**
 * The "Password dictionary" block of the password-policy page and its routes.
 * @param {object} o
 * @param {string} o.p - path of the password-policy page
 */
export function mountPasswordDictionary({ app, db, guard, stepUp = [], p, dictionary, tx, localeOf, readFormFn = readForm }) {
  const base = `${p}/dictionary`;
  const audit = async (req, action, meta) => await logAsync(db, { ...contextFromRequest(req), action, entity: 'password_dictionary', meta });
  const back = (res, q) => res.redirect(303, `${p}?${q}#dictionary`);
  const bad = (res, code) => back(res, `msg=bad&e=${encodeURIComponent(code)}`);

  /** The HTML block (async: the file is looked at). */
  async function block(req, res) {
    const l = tx(req);
    const f = await dictionary.fileState();
    const all = await dictionary.words();
    const pg = pageParams(req, 'wp');
    const slice = all.slice(pg.offset, pg.offset + pg.size);
    const rows = slice.map((w) => `<tr><td><code translate="no">${esc(w)}</code></td><td><form method="post" action="${base}/remove"><input type="hidden" name="word" value="${esc(w)}"><button class="adm-btn" type="submit">${esc(l.dictRemove)}</button></form></td></tr>`).join('');
    const state = f.path == null ? l.dictNoFile : f.ok ? l.dictFileOk : `${l.dictFileBad}: ${l[`e_${f.error}`] ?? f.error}`;
    const src = f.source === 'setting' ? l.dictSrcSetting : f.source === 'config' ? l.dictSrcConfig : '';
    let res2 = '';
    if (req.query?.chk === '1') {
      const flag = (v) => (v === '1' ? l.dictFound : v === '0' ? l.dictNotFound : l.dictNoFileShort);
      const b = req.query.b === '1'; const c = req.query.c === '1'; const fl = req.query.f === '1';
      res2 = `<div class="adm-toast" style="margin-top:.75rem"><strong>${esc(l.dictRes)}:</strong> ${esc(l.dictBuiltin)} — ${esc(flag(req.query.b))}; ${esc(l.dictOwn)} — ${esc(flag(req.query.c))}; ${esc(l.dictFile)} — ${esc(flag(req.query.f))}. ${esc(b || c || fl ? l.dictAnyBad : l.dictAllOk)}</div>`;
    }
    const added = req.query?.add != null ? `<div class="adm-toast">${esc(l.dictAdded)}: ${esc(String(req.query.add).slice(0, 6))}; ${esc(l.dictSkipped)}: ${esc(String(req.query.skip ?? 0).slice(0, 6))}; ${esc(l.dictInvalid)}: ${esc(String(req.query.inv ?? 0).slice(0, 6))}</div>` : '';
    return `<div class="adm-card" id="dictionary" style="margin-top:1rem"><h2>${esc(l.dictTitle)}</h2><p class="adm-muted">${esc(l.dictText)}</p>
${added}
<p><strong>${esc(l.dictBuiltin)}:</strong> ${esc(dictionary.builtinCount)} ${esc(l.dictBuiltinN)}</p>
<p><strong>${esc(l.dictFile)}:</strong> ${esc(state)}${f.path ? `<br><code translate="no">${esc(f.path)}</code>` : ''}${src ? `<br><span class="adm-muted">${esc(l.dictFileSource)}: ${esc(src)}${f.size ? `; ${esc(l.dictSize)}: ${esc(f.size)}` : ''}</span>` : ''}</p>
<form method="post" action="${base}/file" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-end"><label class="adm-field" style="flex:1;min-width:16rem">${esc(l.dictFilePath)}<input class="adm-input" name="path" maxlength="1024" autocomplete="off" required></label><button class="adm-btn primary" type="submit">${esc(l.dictConnect)}</button></form>
${f.source === 'setting' ? `<form method="post" action="${base}/file-clear" style="margin-top:.5rem"><button class="adm-btn" type="submit">${esc(l.dictDisconnect)}</button></form>` : ''}
<h3 style="margin-top:1.25rem">${esc(l.dictOwn)} (${esc(all.length)}; ${esc(l.dictTotalMax)} ${esc(MAX_CUSTOM_WORDS)})</h3><p class="adm-muted">${esc(l.dictOwnHint)}</p>
<form method="post" action="${base}/add" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-end"><label class="adm-field" style="flex:1;min-width:16rem">${esc(l.dictWord)}<textarea class="adm-input" name="words" rows="2" maxlength="20000" required></textarea></label><button class="adm-btn primary" type="submit">${esc(l.dictAdd)}</button></form>
${rows ? `<table class="adm-table" style="margin-top:.75rem"><thead><tr><th>${esc(l.dictWord)}</th><th></th></tr></thead><tbody data-paged="dict-words">${rows}</tbody></table>${pagerFor({ req, res, path: p, name: 'dict-words', param: 'wp', ...pg, count: slice.length, total: all.length, locale: localeOf(req) })}` : `<p class="adm-muted">${esc(l.dictEmpty)}</p>`}
<h3 style="margin-top:1.25rem">${esc(l.dictCheck)}</h3><p class="adm-muted">${esc(l.dictCheckHint)}</p>
<form method="post" action="${base}/check" autocomplete="off" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-end"><label class="adm-field" style="flex:1;min-width:16rem">${esc(l.dictCheck)}<input class="adm-input" type="password" name="password" maxlength="1024" autocomplete="off" required></label><button class="adm-btn" type="submit">${esc(l.dictCheckBtn)}</button></form>${res2}</div>`;
  }

  app.post(`${base}/add`, ...guard, ...stepUp, async (req, res, next) => {
    try {
      const f = await readFormFn(req);
      const r = await dictionary.addWords(String(f.words ?? '').slice(0, 20000));
      if (r.added === 0 && r.invalid > 0) return bad(res, 'WORD_INVALID');
      if (r.added > 0) await audit(req, 'admin.passworddict.words_add', { added: r.added, total: r.total });
      back(res, `msg=ok&add=${r.added}&skip=${r.skipped}&inv=${r.invalid}`);
    } catch (e) {
      if (e instanceof PasswordDictionaryError) return bad(res, e.code);
      next(e);
    }
  });

  app.post(`${base}/remove`, ...guard, ...stepUp, async (req, res, next) => {
    try {
      const f = await readFormFn(req);
      if (await dictionary.removeWord(String(f.word ?? ''))) await audit(req, 'admin.passworddict.words_remove', { total: (await dictionary.words()).length });
      back(res, 'msg=ok');
    } catch (e) { next(e); }
  });

  app.post(`${base}/file`, ...guard, ...stepUp, async (req, res, next) => {
    try {
      const f = await readFormFn(req);
      const path = String(f.path ?? '').trim();
      const info = await dictionary.setFile(path);
      await audit(req, 'admin.passworddict.file_set', { path, size: info.size });
      back(res, 'msg=ok');
    } catch (e) {
      if (e instanceof PasswordDictionaryError) return bad(res, e.code);
      next(e);
    }
  });

  app.post(`${base}/file-clear`, ...guard, ...stepUp, async (req, res, next) => {
    try {
      await dictionary.clearFile();
      await audit(req, 'admin.passworddict.file_clear');
      back(res, 'msg=ok');
    } catch (e) { next(e); }
  });

  // Only flags travel in the redirect: the password itself never reaches a URL, the log or the audit trail.
  app.post(`${base}/check`, ...guard, ...stepUp, async (req, res, next) => {
    try {
      const f = await readFormFn(req);
      const r = await dictionary.inspect(String(f.password ?? '').slice(0, 1024));
      const flag = (v) => (v === null ? '-' : v ? '1' : '0');
      back(res, `chk=1&b=${flag(r.builtin)}&c=${flag(r.custom)}&f=${flag(r.file)}`);
    } catch (e) { next(e); }
  });

  return { block };
}
