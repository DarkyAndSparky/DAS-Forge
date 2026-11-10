/**
 * db.createFtsIndex() — SQLite FTS5, built into node:sqlite, no extra dep.
 *
 * Creates an external-content FTS5 virtual table mirroring `columns` of
 * `table`, plus triggers to keep it in sync on insert/update/delete.
 * This is the standard "external content table" FTS5 pattern so the
 * indexed text isn't duplicated as the source of truth.
 *
 * Wired into the UI search-provider pattern (§6.6.3): each module
 * registers a search provider that queries its own FTS table.
 */
import { assertSafeIdentifier, normalizeLimit } from './identifiers.js';

/**
 * Turns arbitrary user text into a safe FTS5 MATCH expression: every
 * whitespace-separated word becomes a quoted phrase, so `C++`, `foo-bar`,
 * `a:b`, `NEAR(` or an unbalanced quote are searched literally instead of
 * raising `fts5: syntax error` (audit B08). Words are AND-ed (FTS5's
 * implicit operator). Returns null for input with no searchable words -
 * callers should return an empty result instead of running the query.
 */
/** ё→е, Ё→Е. Apply it to the text you index (e.g. a shadow column written together with the
 * original) AND to the query (`escapeQuery(text, { foldYo: true })`) to make ё/е interchangeable. */
export function foldYo(text) {
  return String(text ?? '').replace(/ё/g, 'е').replace(/Ё/g, 'Е');
}

export function ftsEscape(userInput, { prefix = false, foldYo: fold = false } = {}) {
  const words = (fold ? foldYo(userInput) : String(userInput ?? ''))
    .split(/\s+/)
    .map((w) => w.replace(/"/g, '""'))
    .filter((w) => w.length > 0);
  // `"word"*` = every token that STARTS with the word. SQLite has no Russian
  // stemmer, so this is the practical way to make "ноутбук" find "ноутбуки",
  // "ноутбуков", "ноутбуком" (audit B09).
  return words.length === 0 ? null : words.map((w) => (prefix ? `"${w}"*` : `"${w}"`)).join(' ');
}

/**
 * Default tokenizer: unicode61 folds the case of Cyrillic. Its `remove_diacritics`
 * only knows Latin letters (checked against SQLite: "свекла" does NOT find "свёкла"),
 * so ё/е is handled by `foldYo()` below instead.
 */
export const DEFAULT_FTS_TOKENIZER = 'unicode61 remove_diacritics 2';

/**
 * @param {object} [opts]
 * @param {string} [opts.rowidColumn='rowid']
 * @param {string} [opts.tokenize] FTS5 tokenizer spec, default DEFAULT_FTS_TOKENIZER. Fixed when the
 *   index is created: changing it later means dropping `<table>_fts` and creating it again.
 * @param {number[]} [opts.prefixLengths] build prefix indexes (e.g. [2, 3]) to make `prefix: true`
 *   searches fast on big tables.
 */
export function createFtsIndex(db, table, columns, { rowidColumn = 'rowid', tokenize = DEFAULT_FTS_TOKENIZER, prefixLengths = [] } = {}) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new TypeError('createFtsIndex requires a non-empty columns array');
  }
  assertSafeIdentifier(table, 'table');
  assertSafeIdentifier(rowidColumn, 'rowid column');
  for (const c of columns) assertSafeIdentifier(c, 'column');

  const ftsTable = `${table}_fts`;
  const colList = columns.join(', ');

  if (typeof tokenize !== 'string' || !/^[A-Za-z0-9_ ]+$/.test(tokenize)) {
    throw new TypeError('createFtsIndex: tokenize must be a plain FTS5 tokenizer spec such as "unicode61 remove_diacritics 2"');
  }
  if (!Array.isArray(prefixLengths) || prefixLengths.some((n) => !Number.isInteger(n) || n < 1 || n > 10)) {
    throw new TypeError('createFtsIndex: prefixLengths must be integers from 1 to 10');
  }
  const prefixOpt = prefixLengths.length ? `, prefix='${prefixLengths.join(' ')}'` : '';

  const existed = Boolean(db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`).get(ftsTable));

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTable}
    USING fts5(${colList}, content='${table}', content_rowid='${rowidColumn}', tokenize='${tokenize}'${prefixOpt});
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_ai AFTER INSERT ON ${table} BEGIN
      INSERT INTO ${ftsTable}(rowid, ${colList})
      VALUES (new.${rowidColumn}, ${columns.map((c) => `new.${c}`).join(', ')});
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_ad AFTER DELETE ON ${table} BEGIN
      INSERT INTO ${ftsTable}(${ftsTable}, rowid, ${colList})
      VALUES ('delete', old.${rowidColumn}, ${columns.map((c) => `old.${c}`).join(', ')});
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_au AFTER UPDATE OF ${colList} ON ${table} BEGIN
      INSERT INTO ${ftsTable}(${ftsTable}, rowid, ${colList})
      VALUES ('delete', old.${rowidColumn}, ${columns.map((c) => `old.${c}`).join(', ')});
      INSERT INTO ${ftsTable}(rowid, ${colList})
      VALUES (new.${rowidColumn}, ${columns.map((c) => `new.${c}`).join(', ')});
    END;
  `);

  const rebuild = () => db.exec(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES ('rebuild');`);
  // A brand-new index over a table that already has rows would otherwise find nothing
  // until someone remembers to call rebuild() (audit B09). Not repeated on later starts.
  if (!existed) rebuild();

  return {
    tableName: ftsTable,
    /** Builds a ready-to-run search query string against this index. */
    /** Escapes user text for the `MATCH ?` parameter of searchSql(). */
    escapeQuery: (text, options) => ftsEscape(text, options),
    /**
     * Re-indexes every row currently in the source table - needed when
     * the index is created on a table that already has data (the
     * triggers only see FUTURE writes). Safe to call repeatedly.
     */
    rebuild,
    searchSql: (limit = 20) =>
      `SELECT ${table}.* FROM ${ftsTable}
       JOIN ${table} ON ${table}.${rowidColumn} = ${ftsTable}.rowid
       WHERE ${ftsTable} MATCH ?
       ORDER BY rank
       LIMIT ${normalizeLimit(limit)}`,
  };
}
