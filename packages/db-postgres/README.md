# @das-forge/db-postgres

Драйвер PostgreSQL для DAS-Forge (ADR-0010). Даёт ядру асинхронную базу данных поверх пула `pg`: все модули, которые работают через `asyncDb(db)`, работают и на PostgreSQL.

```js
import { createPostgresDatabase } from '@das-forge/db-postgres';
import { ensureAuthTablesAsync } from '@das-forge/core/auth';

const db = await createPostgresDatabase({ connectionString: process.env.DATABASE_URL, max: 10 });
await ensureAuthTablesAsync(db);   // таблицы создаются один раз при старте, не в транзакции
```

Нужен пакет `pg` (`npm install pg`) или свой пул: `createPostgresDatabase({ pool })`.

## Что делает драйвер

- Запросы ядра пишутся в «SQLite-стиле» (`?`); перед выполнением их переводит слой диалектов ядра (`translate(sql, 'postgres')`): `$1, $2…`, `datetime('now')`, автонумерация, `INTEGER` → `BIGINT`, `BLOB` → `BYTEA`, `INSERT OR IGNORE`.
- `run()` возвращает `{ changes, lastInsertRowid }`: к `INSERT` в таблицу с колонкой `id` добавляется `RETURNING id`.
- Числа `BIGINT` (`COUNT(*)`) приходят как числа JavaScript (при своём пуле передайте `types` с разбором oid 20).
- Нарушения ограничений получают текст SQLite (`UNIQUE constraint failed: users.username`), код SQLSTATE остаётся в `error.code`.
- Транзакции идут по одному соединению пула, вложенные — точки сохранения. Режимы `immediate` и `exclusive` берут консультативную блокировку `pg_advisory_xact_lock`: это замена единственному писателю SQLite, цепочка аудита и «прочитал, решил, записал» безопасны между процессами.
- Копия базы: `await db.snapshotToAsync(path, { check: true })` вызывает `pg_dump --format=custom` (нужны клиентские утилиты PostgreSQL), проверка читает файл через `pg_restore --list`.

## Что ещё не сделано

- `INSERT OR REPLACE`, `PRAGMA integrity_check` и часть служебных запросов — только для SQLite; список даёт `node scripts/sqlite-only-report.mjs`. Полнотекстовый поиск: `createFtsIndexAsync` (GIN-индекс по `to_tsvector`).
- Часть конструкторов (`createX({ db })`) создаёт таблицы синхронно: для PostgreSQL вызывайте `ensure…Async` при старте.

## Перенос данных из SQLite

1. Создайте в PostgreSQL пустую базу и задайте переменную окружения со строкой подключения (например `DATABASE_URL`).
2. Запустите приложение один раз с `database.driver: postgres`, чтобы оно создало свои таблицы и триггеры (в частности, триггер «только добавление» журнала аудита), либо вызовите нужные `ensure…Async`.
3. Остановите приложение на SQLite и выполните на нём: `app db copy --to DATABASE_URL --dry-run` (проверка, ничего не пишется), затем `app db copy --to DATABASE_URL`.
4. Команда копирует все таблицы (порядок учитывает внешние ключи), переводит счётчики идентификаторов за скопированные значения и сверяет число строк. Целевые таблицы должны быть пустыми. Не копируются полнотекстовые индексы (создайте их `createFtsIndexAsync`) и триггеры.
5. Переключите `database.driver` на `postgres`. Цепочка аудита после переноса проверяется командой `audit verify`.

Из кода: `copyDatabaseAsync(sqliteDb, postgresDb, { tables, skip, dryRun, batchSize, onProgress })` из `@das-forge/core/database`.

## Тесты

Тесты драйвера и модулей ядра на PostgreSQL выполняются, когда задана база для проверки (схема `public` будет удалена и создана заново):

```
DAS_TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/dastest npm test --workspace=@das-forge/db-postgres
```

Без переменной тесты базы пропускаются.
