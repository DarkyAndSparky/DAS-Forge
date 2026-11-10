/**
 * Search over the admin sections: by name and by the words a person would look for ("password", "copy", "logo").
 * It finds SECTIONS (and says where they are in the menu); it does not look inside settings values.
 */

/** Extra words per section key, by language. The section's own name is always searched too. */
export const SECTION_WORDS = {
  users: { ru: 'учётные записи аккаунты пользователь роль сброс пароля выход принудительно блокировка удалить обезличить', en: 'accounts user role reset password force logout lock delete anonymize' },
  audit: { ru: 'журнал аудита входы события экспорт цепочка история действий', en: 'log journal sign-ins events export chain history actions' },
  security: { ru: 'баны блокировки ip адреса сессии подбор пароля порог попыток', en: 'bans blocks ip addresses sessions brute force threshold attempts' },
  passwordPolicy: { ru: 'пароль длина сложность срок действия смена требования фстэк nist', en: 'password length complexity lifetime change requirements nist' },
  incidents: { ru: 'инциденты утечка уведомление роскомнадзор срок важность', en: 'incidents breach notification deadline severity' },
  registry: { ru: 'реестр обработки персональные данные цели основания 152-фз', en: 'processing register personal data purposes legal basis gdpr' },
  policy: { ru: 'политики лицензия соглашение cookie куки конфиденциальность тексты', en: 'policies licence agreement cookies privacy texts' },
  alerts: { ru: 'алерты оповещения уведомления почта порог', en: 'alerts notifications mail threshold' },
  logs: { ru: 'логи журнал приёмники сервер отправка syslog файл', en: 'logs sinks syslog file shipping' },
  config: { ru: 'конфигурация настройки параметры порты окружение', en: 'configuration settings parameters ports environment' },
  about: { ru: 'о системе версия зависимости лицензии компоненты диагностика проверка обновлений', en: 'about version dependencies licences components diagnostics updates' },
  backups: { ru: 'резервные копии бэкап восстановление расписание хранение шифрование', en: 'backups restore schedule retention encryption' },
  maintenance: { ru: 'режим обслуживания технические работы закрыть доступ 503', en: 'maintenance mode downtime close access 503' },
  announcement: { ru: 'объявление баннер сообщение всем', en: 'announcement banner message' },
  tasks: { ru: 'задачи расписание планировщик запуск cron', en: 'tasks schedule scheduler run cron' },
  mail: { ru: 'почта очередь письма отправка smtp ошибки', en: 'mail queue emails sending smtp errors' },
  broadcast: { ru: 'рассылка письмо всем пользователям группа роль', en: 'broadcast email all users group role' },
  appearance: { ru: 'оформление логотип цвет тема название компании брендинг акцент', en: 'appearance logo colour theme company name branding accent' },
};

const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е');

/** A query word matches a text when the text has it, or (for longer words) its stem: "входили" finds "входил". */
const has = (text, w) => text.includes(w) || (w.length >= 6 && text.includes(w.slice(0, w.length - 2)));

/** Words for pages that live inside a section but that people look for by name. */
SECTION_WORDS.users.ru += ' не входили давно неактивные блокировки входа карточка';
SECTION_WORDS.users.en += ' not signed in for long inactive sign-in lockouts card';

/**
 * Russian and English words for the parts of configuration keys (`server.port` -> "порт"), so that settings are found
 * in either language. A key is searched by its own name plus the words of every part.
 */
export const CONFIG_WORDS = {
  server: ['сервер', 'server'], port: ['порт', 'port'], host: ['адрес хост', 'host address'], tls: ['сертификат шифрование https', 'certificate encryption https'],
  cert: ['сертификат', 'certificate'], key: ['ключ', 'key'], secret: ['секрет', 'secret'], password: ['пароль', 'password'], session: ['сессия сеанс', 'session'],
  cookie: ['куки', 'cookie'], security: ['безопасность', 'security'], lockout: ['блокировка попытки входа', 'lockout attempts'], maxFailures: ['число попыток', 'attempts'],
  rateLimit: ['лимит запросов частота', 'rate limit requests'], loginRateLimit: ['лимит входа', 'login limit'], windowMs: ['окно время мс', 'window time'],
  max: ['максимум предел', 'maximum limit'], email: ['почта письма', 'mail e-mail'], smtp: ['почта smtp', 'mail smtp'], backup: ['резервные копии бэкап', 'backup'],
  retention: ['хранение срок', 'retention'], keep: ['хранить', 'keep'], destinations: ['места назначения', 'destinations'], logging: ['журнал логи', 'logging logs'],
  level: ['уровень', 'level'], audit: ['аудит журнал', 'audit'], database: ['база данных', 'database'], file: ['файл', 'file'], enabled: ['включено', 'enabled'],
  schedule: ['расписание', 'schedule'], cors: ['источники кросс-доменные', 'cors origins'], origins: ['источники', 'origins'], csrf: ['защита csrf', 'csrf'],
  maintenance: ['обслуживание', 'maintenance'], alerts: ['алерты оповещения', 'alerts'], ldap: ['каталог ldap active directory', 'directory ldap'], url: ['адрес ссылка', 'url'],
  upload: ['загрузка файлов', 'upload'], uploads: ['загрузка файлов', 'uploads'], size: ['размер', 'size'], timeout: ['тайм-аут', 'timeout'], metrics: ['метрики', 'metrics'],
  incidentContacts: ['контакты инцидентов', 'incident contacts'], locale: ['язык', 'language locale'], theme: ['тема оформление', 'theme'], brand: ['бренд', 'brand'],
};

/** Searchable text of one configuration key: the key, plus the words of each of its parts in both languages. */
export function configKeyText(key) {
  const parts = String(key).split(/[.\[\]]+/).filter(Boolean);
  return norm(`${key} ${parts.map((x) => (CONFIG_WORDS[x] ?? []).join(' ')).join(' ')}`);
}

/** Does a query (several words, all required) match a configuration key, in either language? */
export function configKeyMatches(key, query) {
  const words = norm(query).split(/\s+/).filter(Boolean).slice(0, 8);
  if (!words.length) return true;
  const text = configKeyText(key);
  return words.every((w) => has(text, w));
}

/**
 * @param {Array<{key: string|null, label: string, labels?: {ru?: string, en?: string}, group: string, path: string}>} index
 * @returns the entries that contain EVERY word of the query, name matches first. Both languages are searched at once.
 */
export function searchSections(index, query, locale = 'ru', limit = 30) {
  const words = norm(query).split(/\s+/).filter((w) => w.length > 0).slice(0, 8);
  if (!words.length) return [];
  const scored = [];
  for (const e of index) {
    const name = norm(`${e.label} ${e.labels?.ru ?? ''} ${e.labels?.en ?? ''}`);
    const w2 = SECTION_WORDS[e.key];
    const extra = norm(`${w2?.ru ?? ''} ${w2?.en ?? ''} ${e.group} ${e.extra ?? ''}`);
    if (!words.every((w) => has(name, w) || has(extra, w))) continue;
    scored.push([words.every((w) => has(name, w)) ? 0 : 1, e]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map((x) => x[1]);
}
