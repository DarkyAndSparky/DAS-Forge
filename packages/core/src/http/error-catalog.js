import { getTextOverrides } from '../i18n/overrides.js';
/**
 * Texts for error pages / API errors, ru and en. Every entry: a short title, what happened, and what
 * the person can do (hint). Codes not listed fall back to the generic 4xx / 5xx entry.
 */
export const ERROR_CATALOG = {
  ru: {
    400: { title: 'Некорректный запрос', message: 'Сервер не смог разобрать запрос.', hint: 'Проверьте введённые данные и повторите.' },
    401: { title: 'Требуется вход', message: 'Для этого действия нужно войти в систему.', hint: 'Войдите и повторите попытку.' },
    403: { title: 'Доступ запрещён', message: 'У вас нет прав на это действие.', hint: 'Если доступ нужен, обратитесь к администратору.' },
    404: { title: 'Страница не найдена', message: 'Запрошенный ресурс не существует или был перемещён.', hint: 'Проверьте адрес или вернитесь на главную.' },
    405: { title: 'Метод не поддерживается', message: 'Для этого адреса такой способ запроса не разрешён.', hint: 'Вернитесь назад и повторите действие из интерфейса.' },
    408: { title: 'Время ожидания истекло', message: 'Запрос шёл слишком долго.', hint: 'Повторите попытку.' },
    409: { title: 'Конфликт данных', message: 'Данные уже изменились или противоречат существующим.', hint: 'Обновите страницу и повторите.' },
    413: { title: 'Слишком большой запрос', message: 'Размер отправленных данных превышает допустимый.', hint: 'Уменьшите размер файла или данных.' },
    415: { title: 'Неподдерживаемый тип данных', message: 'Сервер не принимает данные такого типа.', hint: 'Проверьте формат файла.' },
    422: { title: 'Данные не прошли проверку', message: 'Некоторые значения указаны неверно.', hint: 'Исправьте отмеченные поля.' },
    429: { title: 'Слишком много запросов', message: 'Превышен лимит запросов.', hint: 'Подождите немного и повторите.' },
    500: { title: 'Внутренняя ошибка сервера', message: 'Что-то пошло не так на нашей стороне.', hint: 'Повторите позже; если ошибка остаётся, сообщите администратору код запроса.' },
    502: { title: 'Сервис недоступен', message: 'Промежуточный сервер получил некорректный ответ.', hint: 'Повторите через минуту.' },
    503: { title: 'Сервис временно недоступен', message: 'Сервер перегружен или на обслуживании.', hint: 'Повторите через минуту.' },
    504: { title: 'Сервер не ответил вовремя', message: 'Ответ не пришёл за отведённое время.', hint: 'Повторите позже.' },
    402: { title: 'Требуется оплата', message: 'Для этого действия нужна оплата или активная подписка.', hint: 'Обратитесь к администратору.' },
    406: { title: 'Формат недоступен', message: 'Сервер не может ответить в формате, который запросил клиент.', hint: 'Откройте страницу обычным способом.' },
    410: { title: 'Страница удалена', message: 'Этот ресурс удалён и больше не будет доступен.', hint: 'Вернитесь на главную и найдите нужное там.' },
    411: { title: 'Не указана длина', message: 'Запрос пришёл без указания размера данных.', hint: 'Повторите действие из интерфейса.' },
    412: { title: 'Условие не выполнено', message: 'Данные изменились с тех пор, как вы их открыли.', hint: 'Обновите страницу и повторите.' },
    414: { title: 'Слишком длинный адрес', message: 'Адрес страницы длиннее допустимого.', hint: 'Откройте страницу по ссылке из меню.' },
    416: { title: 'Диапазон недоступен', message: 'Запрошенная часть файла недоступна.', hint: 'Скачайте файл целиком.' },
    417: { title: 'Ожидание не принято', message: 'Сервер не принял условие запроса.', hint: 'Повторите действие из интерфейса.' },
    421: { title: 'Запрос не по адресу', message: 'Запрос пришёл на сервер, который не отвечает за этот адрес.', hint: 'Откройте страницу по адресу, который дал администратор.' },
    423: { title: 'Ресурс заблокирован', message: 'Сейчас с этим ресурсом работает кто-то другой.', hint: 'Подождите и повторите.' },
    424: { title: 'Зависимое действие не выполнено', message: 'Операция не удалась, потому что не удалась связанная с ней.', hint: 'Повторите с самого начала.' },
    425: { title: 'Слишком рано', message: 'Сервер не готов обработать запрос так быстро.', hint: 'Повторите через несколько секунд.' },
    426: { title: 'Нужен другой протокол', message: 'Для этого адреса требуется более современное защищённое соединение.', hint: 'Откройте страницу по https.' },
    428: { title: 'Нужно условие запроса', message: 'Запрос должен учитывать текущее состояние данных.', hint: 'Обновите страницу и повторите.' },
    431: { title: 'Слишком большие заголовки', message: 'Служебные данные запроса (например, cookie) превышают допустимый размер.', hint: 'Очистите cookie для этого сайта и войдите снова.' },
    451: { title: 'Недоступно по юридическим причинам', message: 'Доступ к этому ресурсу ограничен по требованию закона.', hint: 'Обратитесь к администратору.' },
    501: { title: 'Не реализовано', message: 'Сервер не умеет выполнять это действие.', hint: 'Сообщите администратору, что вы делали.' },
    505: { title: 'Версия HTTP не поддерживается', message: 'Сервер не поддерживает версию протокола запроса.', hint: 'Обновите браузер или обратитесь к администратору.' },
    507: { title: 'Не хватает места', message: 'На сервере закончилось место для сохранения данных.', hint: 'Сообщите администратору: нужно освободить место.' },
    508: { title: 'Обнаружен цикл', message: 'Обработка запроса зациклилась.', hint: 'Сообщите администратору код запроса.' },
    511: { title: 'Нужна авторизация в сети', message: 'Для доступа нужно сначала войти в сеть (например, на странице Wi-Fi).', hint: 'Выполните вход в сеть и повторите.' },
    maintenance: { title: 'Ведутся технические работы', message: 'Сервис временно недоступен: мы обновляем систему.', hint: 'Эта страница обновится сама. Если нет, зайдите чуть позже.', until: 'Ориентировочное время окончания', retry: 'Повторить сейчас' },
    '4xx': { title: 'Ошибка', message: 'Произошла ошибка при обработке запроса.', hint: 'Проверьте запрос и повторите.' },
    '5xx': { title: 'Ошибка сервера', message: 'Что-то пошло не так на нашей стороне.', hint: 'Повторите позже.' },
    home: 'На главную',
    login: 'Войти',
    requestId: 'код запроса',
  },
  en: {
    400: { title: 'Bad request', message: 'The server could not understand the request.', hint: 'Check the data you entered and try again.' },
    401: { title: 'Sign-in required', message: 'You need to sign in to do this.', hint: 'Sign in and try again.' },
    403: { title: 'Access denied', message: 'You do not have permission to do this.', hint: 'If you need access, contact an administrator.' },
    404: { title: 'Page not found', message: 'The requested resource does not exist or has moved.', hint: 'Check the address or go back to the home page.' },
    405: { title: 'Method not allowed', message: 'This address does not accept that kind of request.', hint: 'Go back and repeat the action from the interface.' },
    408: { title: 'Request timed out', message: 'The request took too long.', hint: 'Try again.' },
    409: { title: 'Data conflict', message: 'The data has changed or conflicts with existing data.', hint: 'Refresh the page and try again.' },
    413: { title: 'Request too large', message: 'The amount of data sent is over the limit.', hint: 'Reduce the file or data size.' },
    415: { title: 'Unsupported data type', message: 'The server does not accept this kind of data.', hint: 'Check the file format.' },
    422: { title: 'Validation failed', message: 'Some values are not valid.', hint: 'Correct the highlighted fields.' },
    429: { title: 'Too many requests', message: 'The request limit was exceeded.', hint: 'Wait a moment and try again.' },
    500: { title: 'Internal server error', message: 'Something went wrong on our side.', hint: 'Try again later; if it persists, give the administrator the request id.' },
    502: { title: 'Service unavailable', message: 'A gateway received an invalid response.', hint: 'Try again in a minute.' },
    503: { title: 'Service temporarily unavailable', message: 'The server is overloaded or under maintenance.', hint: 'Try again in a minute.' },
    504: { title: 'Gateway timeout', message: 'No answer arrived in time.', hint: 'Try again later.' },
    402: { title: 'Payment required', message: 'This action needs a payment or an active subscription.', hint: 'Contact an administrator.' },
    406: { title: 'Format not available', message: 'The server cannot answer in the format the client asked for.', hint: 'Open the page the usual way.' },
    410: { title: 'Page removed', message: 'This resource has been removed and will not come back.', hint: 'Go to the home page and look for it there.' },
    411: { title: 'Length required', message: 'The request arrived without the size of its data.', hint: 'Repeat the action from the interface.' },
    412: { title: 'Precondition failed', message: 'The data changed since you opened it.', hint: 'Refresh the page and try again.' },
    414: { title: 'Address too long', message: 'The page address is longer than allowed.', hint: 'Open the page from the menu.' },
    416: { title: 'Range not available', message: 'The requested part of the file is not available.', hint: 'Download the whole file.' },
    417: { title: 'Expectation failed', message: 'The server did not accept the request condition.', hint: 'Repeat the action from the interface.' },
    421: { title: 'Misdirected request', message: 'The request reached a server that does not serve this address.', hint: 'Open the page at the address the administrator gave you.' },
    423: { title: 'Resource locked', message: 'Somebody else is working with this resource right now.', hint: 'Wait and try again.' },
    424: { title: 'Dependent action failed', message: 'The operation failed because a related one failed.', hint: 'Start again from the beginning.' },
    425: { title: 'Too early', message: 'The server is not ready to process the request that fast.', hint: 'Try again in a few seconds.' },
    426: { title: 'Upgrade required', message: 'This address needs a newer, secure connection.', hint: 'Open the page over https.' },
    428: { title: 'Precondition required', message: 'The request must take the current state of the data into account.', hint: 'Refresh the page and try again.' },
    431: { title: 'Headers too large', message: 'The request metadata (cookies, for example) is over the allowed size.', hint: 'Clear the cookies for this site and sign in again.' },
    451: { title: 'Unavailable for legal reasons', message: 'Access to this resource is restricted by law.', hint: 'Contact an administrator.' },
    501: { title: 'Not implemented', message: 'The server cannot perform this action.', hint: 'Tell an administrator what you were doing.' },
    505: { title: 'HTTP version not supported', message: 'The server does not support the protocol version of the request.', hint: 'Update your browser or contact an administrator.' },
    507: { title: 'Out of storage', message: 'The server has run out of space to save data.', hint: 'Tell an administrator: space must be freed.' },
    508: { title: 'Loop detected', message: 'Processing the request went in circles.', hint: 'Give an administrator the request id.' },
    511: { title: 'Network sign-in required', message: 'You must sign in to the network first (a Wi-Fi sign-in page, for example).', hint: 'Sign in to the network and try again.' },
    maintenance: { title: 'Maintenance in progress', message: 'The service is temporarily unavailable: we are updating the system.', hint: 'This page reloads by itself. If it does not, come back a little later.', until: 'Expected to finish around', retry: 'Retry now' },
    '4xx': { title: 'Error', message: 'An error occurred while handling the request.', hint: 'Check the request and try again.' },
    '5xx': { title: 'Server error', message: 'Something went wrong on our side.', hint: 'Try again later.' },
    home: 'Home',
    login: 'Sign in',
    requestId: 'request id',
  },
};

/**
 * The catalog of one language with the app's overrides (`i18n.setTextOverrides({ errors: { ru: { 404: { title } } } })`)
 * merged in per code and per field.
 */
export function catalogFor(locale = 'ru') {
  const lng = locale === 'en' ? 'en' : 'ru';
  const base = ERROR_CATALOG[lng];
  const extra = getTextOverrides('errors')?.[lng];
  if (!extra) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = v && typeof v === 'object' && base[k] && typeof base[k] === 'object' ? { ...base[k], ...v } : v;
  }
  return out;
}

/** Texts for a status code and locale (unknown code -> generic 4xx/5xx entry; unknown locale -> ru). */
export function errorText(statusCode, locale = 'ru') {
  const dict = catalogFor(locale);
  return dict[statusCode] ?? dict[statusCode >= 500 ? '5xx' : '4xx'];
}

/** 'ru' | 'en': req.locale, else the first supported Accept-Language tag, else `fallback`. */
export function resolveLocale(req, fallback = 'ru') {
  const direct = req?.locale;
  if (direct === 'ru' || direct === 'en') return direct;
  const header = String(req?.headers?.['accept-language'] ?? '');
  for (const part of header.split(',')) {
    const tag = part.trim().slice(0, 2).toLowerCase();
    if (tag === 'ru' || tag === 'en') return tag;
  }
  return fallback;
}
