/**
 * Doctor output in Russian. The checks keep producing English text with
 * stable names (scripts and tests rely on them); this module translates a
 * finished report for people. English is the source language, so `en`
 * returns the report unchanged. A line with no rule stays in English rather
 * than being guessed, and the test suite fails when a check in the core has
 * no rule.
 */

const CATEGORIES = {
  Runtime: 'Среда выполнения', Database: 'База данных', Storage: 'Хранилища', Security: 'Безопасность',
  Hardening: 'Защита', Application: 'Приложение', Dependencies: 'Зависимости', Certificate: 'Сертификат', Integrations: 'Интеграции',
};

const NAMES = {
  'Node.js version': 'Версия Node.js', Platform: 'Платформа', Connection: 'Соединение', Integrity: 'Целостность', Migrations: 'Миграции',
  'Session secret': 'Секрет сессий', 'HTTPS mode': 'Режим HTTPS', 'HTTP to HTTPS': 'Переход с HTTP на HTTPS', 'Cleanup jobs': 'Задачи очистки', 'Step-up confirmation': 'Повторное подтверждение', 'Session secret age': 'Возраст секрета сессий', 'TOTP key age': 'Возраст ключа TOTP', 'Backup key age': 'Возраст ключа копий',
  'Port availability': 'Порт', 'Process user': 'Пользователь процесса', 'Administrators: second factor': 'Администраторы: второй фактор',
  'Last backup': 'Последняя копия', 'Audit chain check': 'Проверка цепочки аудита', 'Audit archive': 'Архив аудита', 'Administration address': 'Адрес администрирования',
  'Proxy trust': 'Доверие прокси', Heap: 'Память (heap)', 'Event loop': 'Цикл событий', 'E-mail': 'Почта',
  'SMTP reachable': 'Сервер SMTP доступен', 'SMTP certificate check': 'Проверка сертификата SMTP', 'SMTP encryption': 'Шифрование SMTP',
  'Sender domain': 'Домен отправителя', 'SPF/DMARC': 'SPF/DMARC', Certificate: 'Сертификат', 'Certificate trust': 'Доверие к сертификату',
  'Dependency vulnerabilities': 'Уязвимости зависимостей', 'Node.js security releases': 'Выпуски безопасности Node.js',
  Data: 'Данные', Backups: 'Копии', 'Backup directory': 'Каталог копий',
};

const SEV = { critical: 'критическая', high: 'высокая', moderate: 'средняя', low: 'низкая' };
const sev = (s) => SEV[s] ?? s;

/** [pattern, replacement]: a string with $1.. or a function of the match groups. */
const MESSAGES = [
  [/^connection ok$/, 'соединение установлено'],
  [/^integrity OK$/, 'целостность в порядке'],
  [/^(\d+) applied, 0 pending$/, '$1 применено, ожидающих нет'],
  [/^(\d+) pending - run `migrate`$/, '$1 ожидают применения: выполните `migrate`'],
  [/^v([\d.]+) \(requires >=(\d+)\.0\.0\)$/, 'v$1 (нужна версия $2.0.0 или новее)'],
  [/^(.+) does not exist yet \(created by the first backup\)$/, '$1 ещё нет (появится при первой копии)'],
  [/^(.+) does not exist$/, '$1 не существует'],
  [/^(.+) writable$/, '$1: запись возможна'],
  [/^(.+) exists but is not writable$/, '$1 существует, но запись невозможна'],
  [/^auth\.sessionSecret is missing or shorter than 16 characters$/, 'auth.sessionSecret не задан или короче 16 символов'],
  [/^auth\.sessionSecret is a known placeholder value - replace it before going live$/, 'auth.sessionSecret — известное значение-заглушка: замените его до запуска в работу'],
  [/^configured, not a known placeholder$/, 'задан, не является известной заглушкой'],
  [/^self-signed in production - fine for internal tools, confirm this is intentional$/, 'самоподписанный сертификат в рабочей среде: для внутренних инструментов допустимо, убедитесь, что это намеренно'],
  [/^behind a reverse proxy: the proxy must redirect port 80 to HTTPS$/, 'за обратным прокси: прокси должен перенаправлять порт 80 на HTTPS'],
  [/^no plain-HTTP redirect listener \(server\.httpRedirectPort is off\): someone typing http:\/\/ gets a refused connection instead of a redirect$/, 'нет слушателя для перенаправления с HTTP (server.httpRedirectPort выключен): при вводе http:// соединение будет отклонено вместо перенаправления'],
  [/^the redirect port (\d+) equals the HTTPS port$/, 'порт перенаправления $1 совпадает с портом HTTPS'],
  [/^http on (\d+) redirects to https on (\d+)$/, 'http на порту $1 перенаправляет на https на порту $2'],
  [/^(.+) is free: this application is not listening on its configured port$/, '$1 свободен: приложение не слушает настроенный порт'],
  [/^(.+) in use by this application$/, '$1 занят этим приложением'],
  [/^(.+) available$/, '$1 свободен'],
  [/^(.+) already in use \(expected if the server is already running\)$/, '$1 уже занят (это нормально, если сервер уже запущен)'],
  [/^running as root - run the service as an unprivileged user \(a flaw in the application would then own the machine\)$/, 'процесс запущен от root: запускайте службу от непривилегированного пользователя (иначе уязвимость приложения отдаст всю машину)'],
  [/^(.+) has mode (\d+) - readable by other users; use (\d+)$/, '$1 имеет права $2 и доступен другим пользователям; задайте $3'],
  [/^(\d+) of (\d+) have an authenticator$/, 'у $1 из $2 есть аутентификатор'],
  [/^(\d+) of (\d+) administrators have no authenticator - enable two-factor sign-in$/, 'у $1 из $2 администраторов нет аутентификатора: включите вход со вторым фактором'],
  [/^no backup run is recorded yet$/, 'ни одной копии пока не записано'],
  [/^(\d+) h ago \(more than (\d+) h\) - is the automatic backup on\?$/, '$1 ч назад (больше $2 ч): включено ли автоматическое копирование?'],
  [/^last verified (\d+) h ago \(more than (\d+) h\)$/, 'последняя проверка $1 ч назад (больше $2 ч)'],
  [/^(\d+) h ago$/, '$1 ч назад'],
  [/^the panel has its own listener \((.+)\) and is not served on the application's address$/, 'у панели свой слушатель ($1), на адресе приложения её нет'],
  [/^the application listens on the loopback address only$/, 'приложение слушает только адрес этой же машины'],
  [/^the administration panel is served on the application's address; set server\.admin\.port to give it a listener of its own \(default 127\.0\.0\.1\)$/, 'панель администрирования доступна на адресе приложения: задайте server.admin.port, чтобы у неё был свой слушатель (по умолчанию 127.0.0.1)'],
  [/^trustProxy is true: any client can forge X-Forwarded-For unless the application port is reachable only from the proxy; prefer a list of proxy addresses$/, 'trustProxy равен true: любой клиент может подделать X-Forwarded-For, если порт приложения доступен не только прокси; лучше указать список адресов прокси'],
  [/^trustProxy is set but https\.mode is "(.+)" - a trusted proxy normally means "reverse-proxy"$/, 'trustProxy задан, но https.mode равен «$1»: доверенный прокси обычно означает «reverse-proxy»'],
  [/^https\.mode is "reverse-proxy" but trustProxy is off: client addresses \(rate limit, bans, audit\) will all be the proxy's$/, 'https.mode равен «reverse-proxy», а trustProxy выключен: все адреса клиентов (лимиты, баны, аудит) будут адресом прокси'],
  [/^a proxy is trusted for forwarded headers$/, 'прокси доверен для заголовков пересылки'],
  [/^(\d+) registered \((.*)\)$/, '$1 зарегистрировано ($2)'],
  [/^standard cleanup jobs are not registered: .*$/, 'стандартные задачи очистки не подключены: сессии, журнал, почта и токены растут без предела (scheduler.registerStandardJobs)'],
  [/^creation date not recorded \(security\.secretsRotation\)$/, 'дата создания не записана (security.secretsRotation)'],
  [/^(\d+) days old \(more than (\d+)\) - rotate the key$/, 'возраст $1 дн. (больше $2) - замените ключ'],
  [/^(\d+) days old$/, 'возраст $1 дн.'],
  [/^dangerous administration actions run without a fresh confirmation \(security\.stepUp\.enabled is false\)$/, 'опасные действия администратора выполняются без повторного подтверждения (security.stepUp.enabled выключено)'],
  [/^forwarded headers are not trusted$/, 'заголовкам пересылки не доверяют'],
  [/^(\d+)% of the heap limit is used$/, 'использовано $1% предела памяти'],
  [/^(\d+)% of the heap limit$/, '$1% предела памяти'],
  [/^timer fired (\d+) ms late - something blocks the loop$/, 'таймер сработал с опозданием на $1 мс: что-то блокирует цикл событий'],
  [/^(\d+) ms drift$/, 'отклонение $1 мс'],
  [/^disabled \(email\.enabled is false\)$/, 'выключена (email.enabled равен false)'],
  [/^smtp\.rejectUnauthorized is false: the server certificate is not verified$/, 'smtp.rejectUnauthorized равен false: сертификат сервера не проверяется'],
  [/^smtp\.requireTLS is false: credentials and mail may travel unencrypted$/, 'smtp.requireTLS равен false: пароли и письма могут идти без шифрования'],
  [/^cannot find a domain in email\.from \((.*)\)$/, 'в email.from не найден домен ($1)'],
  [/^(.+): SPF and DMARC are published$/, '$1: записи SPF и DMARC опубликованы'],
  [/^could not check DNS for (.+) \((.+)\)$/, 'не удалось проверить DNS для $1 ($2)'],
  [/^SPF record is missing for (.+)$/, 'для $1 нет записи SPF'],
  [/^SPF for (.+) does not end with -all or ~all \(anyone may be allowed to send\)$/, 'SPF для $1 не заканчивается на -all или ~all (отправлять почту может кто угодно)'],
  [/^DMARC record is missing for (.+) \(recommended: p=quarantine at least\)$/, 'для $1 нет записи DMARC (рекомендуется минимум p=quarantine)'],
  [/^DMARC policy for (.+) is "(.+)" \(recommended: quarantine or reject\)$/, 'политика DMARC для $1: «$2» (рекомендуется quarantine или reject)'],
  [/^no certificate at (.+) - run `cert generate`$/, 'сертификата нет по пути $1: выполните `cert generate`'],
  [/^expired (\d+) day\(s\) ago - run `cert renew`$/, 'истёк $1 дн. назад: выполните `cert renew`'],
  [/^expires in (\d+) day\(s\) - run `cert renew`$/, 'истекает через $1 дн.: выполните `cert renew`'],
  [/^valid \(expires in (\d+) days\)$/, 'действителен (истекает через $1 дн.)'],
  [/^self-signed - not trusted by default in browsers \(see `cert trust`\)$/, 'самоподписанный: браузеры по умолчанию ему не доверяют (см. `cert trust`)'],
  [/^(\d+) packages checked: (.+)$/, (m) => `проверено пакетов: ${m[1]}: ${m[2]}`.replace(/no known vulnerabilities/, 'известных уязвимостей нет').replace(/(\d+) (critical|high|moderate|low)\b/g, (_, n, s) => `${n} ${sev(s)}`).replace(/, (\d+) accepted/, ', принято к сведению: $1').replace(/\(data from (.+?); (.+?)\)/, '(данные от $1; $2)')],
  [/^(critical|high|moderate|low): (.+)$/, (m) => `${sev(m[1])}: ${m[2]}`],
  [/^not checked: (.+)$/, 'не проверено: $1'],
  [/^(.+) is behind (.+), a release of the same line with security fixes: update Node\.js$/, '$1 отстаёт от $2, выпуска той же ветки с исправлениями безопасности: обновите Node.js'],
  [/^(.+): no newer security release in line (\d+)\.x$/, '$1: новее выпусков безопасности в ветке $2.x нет'],
];

const PREFIX_NAMES = [[/^Permissions: (.+)$/, 'Права доступа: $1']];

function apply(rules, text) {
  for (const [re, to] of rules) {
    const m = re.exec(text);
    if (m) return typeof to === 'function' ? to(m) : text.replace(re, to);
  }
  return null;
}

export function localizeName(name, locale) {
  if (locale !== 'ru') return name;
  return NAMES[name] ?? apply(PREFIX_NAMES, name) ?? name;
}

export function localizeMessage(message, locale) {
  if (locale !== 'ru') return message;
  return apply(MESSAGES, String(message)) ?? message;
}

export function localizeCategory(name, locale) {
  return locale === 'ru' ? CATEGORIES[name] ?? name : name;
}

/** Same report shape, texts translated; the input is not modified. */
export function localizeDoctor(result, locale) {
  if (locale !== 'ru') return result;
  return {
    ...result,
    categories: result.categories.map((c) => ({
      ...c,
      name: localizeCategory(c.name, locale),
      checks: c.checks.map((k) => ({ ...k, name: localizeName(k.name, locale), message: localizeMessage(k.message, locale) })),
    })),
  };
}

/** For the coverage test: every English name and category that has a rule. */
export const DOCTOR_NAMES = Object.keys(NAMES);
export const DOCTOR_CATEGORIES = Object.keys(CATEGORIES);
