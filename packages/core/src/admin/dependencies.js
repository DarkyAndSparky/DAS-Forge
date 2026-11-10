import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What each dependency of the core is for (shown on the admin "About" page and in the generated
 * dependency table of the documentation). A test requires an entry for every dependency in
 * `packages/core/package.json`, so a new package cannot be added without saying why it is there.
 * `load`: 'always' - loaded together with the core; 'lazy' - imported only when its feature is used
 * (`test/lazy-imports.test.js` proves the lazy ones are not loaded by importing the core).
 */
export const DEPENDENCY_PURPOSE = Object.freeze({
  zod: { load: 'always', ru: 'Схемы и проверка ввода: конфигурация, тела запросов', en: 'Schemas and input validation: configuration, request bodies' },
  argon2: { load: 'lazy', ru: 'Хеширование паролей (argon2id)', en: 'Password hashing (argon2id)' },
  sharp: { load: 'lazy', ru: 'Обработка загружаемых изображений: перекодирование, удаление EXIF', en: 'Uploaded image processing: re-encoding, EXIF removal' },
  dompurify: { load: 'lazy', ru: 'Очистка загружаемых SVG', en: 'Sanitising uploaded SVG' },
  jsdom: { load: 'lazy', ru: 'DOM для DOMPurify при очистке SVG', en: 'DOM for DOMPurify when sanitising SVG' },
  selfsigned: { load: 'lazy', ru: 'Самоподписанный сертификат (режим self-signed, `cert generate`)', en: 'Self-signed certificate (self-signed mode, `cert generate`)' },
  semver: { load: 'always', ru: 'Сравнение версий с диапазонами: проверка уязвимостей зависимостей и версии Node', en: 'Comparing versions with ranges: dependency vulnerability and Node version checks' },
  ssh2: { load: 'lazy', ru: 'SFTP-приёмник резервных копий', en: 'SFTP backup destination' },
  ldapts: { load: 'lazy', ru: 'Вход через LDAP / Active Directory', en: 'LDAP / Active Directory sign-in' },
  qrcode: { load: 'lazy', ru: 'QR-коды для подключения TOTP', en: 'QR codes for TOTP enrolment' },
  helmet: { load: 'always', ru: 'Заголовки безопасности: CSP, COOP/CORP, X-Frame-Options', en: 'Security headers: CSP, COOP/CORP, X-Frame-Options' },
  'express-rate-limit': { load: 'always', ru: 'Ограничение частоты запросов (429, Retry-After)', en: 'Request rate limiting (429, Retry-After)' },
  cors: { load: 'always', ru: 'CORS по точному списку источников', en: 'CORS with an exact origin list' },
  compression: { load: 'always', ru: 'Сжатие ответов (SSE не сжимается)', en: 'Response compression (SSE is never compressed)' },
  nodemailer: { load: 'lazy', ru: 'Отправка системных писем (SMTP, DKIM)', en: 'System e-mail delivery (SMTP, DKIM)' },
  '@prometheus-io/client': { load: 'lazy', ru: 'Метрики Prometheus (`/metrics`), только при включённых метриках', en: 'Prometheus metrics (`/metrics`), only when metrics are switched on' },
  otplib: { load: 'always', ru: 'Одноразовые коды TOTP', en: 'TOTP one-time codes' },
  pino: { load: 'always', ru: 'Структурированные журналы', en: 'Structured logging' },
  'pino-http': { load: 'always', ru: 'Журнал запросов (access log)', en: 'Request (access) log' },
  yauzl: { load: 'always', ru: 'Чтение ZIP: проверка загрузок, восстановление копий, чтение Excel', en: 'Reading ZIP: upload checks, backup restore, reading Excel' },
  yazl: { load: 'always', ru: 'Запись ZIP: резервные копии, выгрузка в Excel', en: 'Writing ZIP: backups, Excel export' },
  multer: { load: 'lazy', ru: 'Приём multipart-загрузок (один файл в память, жёсткий лимит)', en: 'Multipart uploads (one file in memory, hard limit)' },
  uuid: { load: 'always', ru: 'Идентификаторы запросов и имена загружаемых файлов', en: 'Request ids and uploaded file names' },
  'libheif-js': { load: 'lazy', ru: 'Декодер HEIC/HEIF (WASM) для загрузок с телефона', en: 'HEIC/HEIF decoder (WASM) for phone uploads' },
  docx: { load: 'lazy', ru: 'Отчёты в формате .docx', en: '.docx reports' },
  i18next: { load: 'lazy', ru: 'Переводы ru/en: пространства имён, множественные формы', en: 'ru/en translations: namespaces, plural forms' },
  express: { load: 'always', ru: 'HTTP-сервер (peer: ставит приложение)', en: 'HTTP server (peer: installed by the application)' },
  'cookie-parser': { load: 'always', ru: 'Разбор cookie для сессий и CSRF (peer)', en: 'Cookie parsing for sessions and CSRF (peer)' },
  'express-session': { load: 'lazy', ru: 'Сессии: подписанная cookie и своё хранилище в SQLite (peer)', en: 'Sessions: signed cookie and own SQLite store (peer)' },
  'pino-pretty': { load: 'lazy', ru: 'Читаемый вывод журналов в терминале (peer, необязателен)', en: 'Readable log output in a terminal (optional peer)' },
});

const CORE_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function installedOf(name, bases) {
  const f = bases.map((b) => path.join(b, name, 'package.json')).find((x) => existsSync(x));
  const j = f ? readJson(f) : null;
  return { installed: j?.version ?? null, license: typeof j?.license === 'string' ? j.license : j?.license?.type ?? null };
}

/**
 * Dependencies of the core itself (runtime and peer; dev packages are not part of what an application runs):
 * `[{ name, range, installed, license, group: 'core', peer, optional }]`. The core's own `package.json` is found
 * next to the code, wherever the core is installed.
 */
export function readCoreDependencies({ coreDir = CORE_DIR, nodeModulesDir } = {}) {
  const pkg = readJson(path.join(coreDir, 'package.json'));
  if (!pkg) return [];
  const bases = [].concat(nodeModulesDir ?? [], path.join(coreDir, 'node_modules'), path.resolve(coreDir, '..', '..', 'node_modules'), path.resolve(coreDir, '..'));
  const peerMeta = pkg.peerDependenciesMeta ?? {};
  const rows = [
    ...Object.entries(pkg.dependencies ?? {}).map(([name, range]) => ({ name, range, peer: false, optional: false })),
    ...Object.entries(pkg.peerDependencies ?? {}).map(([name, range]) => ({ name, range, peer: true, optional: peerMeta[name]?.optional === true })),
  ];
  return rows.map((r) => ({ ...r, ...installedOf(r.name, bases), group: 'core' }));
}
