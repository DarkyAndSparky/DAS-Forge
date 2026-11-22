/**
 * `defineEntity` (ADR-0012): the description of one entity as plain data, checked at definition time.
 *
 * It is the single source of truth for the table (`ddl`), the input check (`validate`), the stored/API conversions
 * (`toStorage`, `fromStorage`, `publicShape`), the list and the permissions. Nothing here touches a database or Express.
 */
import { assertSafeIdentifier } from '../database/identifiers.js';
import { BUILT_IN_TYPES, assertFieldTypeDefinition, columnOf } from './fields.js';

export class EntityDefinitionError extends Error {
  constructor(entity, path, message) {
    super(`entity ${entity ?? '?'}${path ? `.${path}` : ''}: ${message}`);
    this.name = 'EntityDefinitionError';
    this.entity = entity;
    this.path = path;
  }
}

const types = new Map(Object.entries(BUILT_IN_TYPES));

/** Registers an application's own field type; afterwards `field.<name>(opts)` exists. Same required properties as the built-ins. */
export function registerFieldType(name, def) {
  assertFieldTypeDefinition(name, def);
  if (types.has(name)) throw new TypeError(`field type ${name} is already registered`);
  types.set(name, def);
  field[name] = (opts = {}) => Object.freeze({ type: name, ...opts });
}

/** Field descriptors: `field.text({ max: 200 })`, `field.enum(['a','b'])`, `field.ref('users')`, `field.money({ currency: 'RUB' })`, ... */
export const field = {};
for (const name of Object.keys(BUILT_IN_TYPES)) field[name] = (opts = {}) => Object.freeze({ type: name, ...opts });
field.enum = (values, opts = {}) => Object.freeze({ type: 'enum', values: Object.freeze([...values]), ...opts });
field.ref = (entity, opts = {}) => Object.freeze({ type: 'ref', entity, ...opts });

export const RESERVED_FIELDS = new Set(['id', 'tenantId', 'createdAt', 'updatedAt', 'deletedAt', 'version', 'attrs']);
const FEATURES = { audit: true, softDelete: false, optimisticLock: true, history: false, attachments: false };
const HOOKS = new Set(['beforeCreate', 'afterCreate', 'beforeUpdate', 'afterUpdate', 'beforeDelete', 'afterDelete']);
// Words that are reserved in SQLite or PostgreSQL: the generated SQL does not quote names, so a column of this name would not run.
const SQL_RESERVED = new Set(('all analyse analyze and any array as asc asymmetric authorization between binary both case cast check collate column constraint create cross '
  + 'current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for '
  + 'foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not '
  + 'notnull null offset on only or order outer overlaps placing primary references returning right select session_user similar some symmetric table tablesample then to '
  + 'trailing true union unique user using variadic verbose when where window with abort add alter begin commit delete drop exists index insert rollback set transaction update '
  + 'values view trigger rename').split(' '));
const FIELD_NAME = /^[a-z][a-zA-Z0-9]*$/;
const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {object} def - see ADR-0012
 * @returns {Readonly<object>} the entity: the checked definition plus `validate`, `ddl`, `toStorage`, `fromStorage`, `publicShape`
 */
export function defineEntity(def) {
  const name = def?.name;
  const fail = (path, msg) => { throw new EntityDefinitionError(name, path, msg); };
  if (!isObj(def)) throw new EntityDefinitionError(undefined, '', 'a definition object is required');
  if (typeof name !== 'string' || !FIELD_NAME.test(name)) fail('name', 'must be camelCase Latin letters and digits');
  if (typeof def.table !== 'string' || !/^[a-z][a-z0-9_]*$/.test(def.table) || def.table.length > 40) fail('table', 'must be lower-case snake_case, up to 40 characters');
  for (const lng of ['ru', 'en']) {
    const l = def.label?.[lng];
    if (!Array.isArray(l) || l.length !== 2 || !l.every((x) => typeof x === 'string' && x)) fail(`label.${lng}`, 'must be [singular, plural]');
  }
  const tenant = def.tenant ?? 'tenant';
  if (!['tenant', 'global'].includes(tenant)) fail('tenant', "must be 'tenant' or 'global'");
  const idType = def.idType ?? 'int';
  if (!['int', 'text'].includes(idType)) fail('idType', "must be 'int' or 'text'");

  const compileFields = (fields, prefix, taken) => {
    const out = Object.create(null); // no inherited names (`constructor`, `toString`): a lookup by a request's key finds only real fields
    for (const [fname, f] of Object.entries(fields ?? {})) {
      const path = `${prefix}${fname}`;
      if (!FIELD_NAME.test(fname)) fail(path, 'field name must be camelCase');
      if (RESERVED_FIELDS.has(fname)) fail(path, 'name is reserved by the core');
      if (taken.has(fname)) fail(path, 'duplicate field name');
      const t = types.get(f?.type);
      if (!t) fail(path, `unknown field type ${JSON.stringify(f?.type)}`);
      if (f.type === 'enum' && (!Array.isArray(f.values) || f.values.length === 0 || !f.values.every((v) => typeof v === 'string' && v))) fail(path, 'enum needs a non-empty list of string values');
      if (f.type === 'ref' && (typeof f.entity !== 'string' || !f.entity)) fail(path, 'ref needs the name of the target entity');
      if (f.type === 'ref' && f.idType !== undefined && !['int', 'text'].includes(f.idType)) fail(path, "ref idType must be 'int' or 'text'");
      const column = f.column ?? snake(fname);
      try { assertSafeIdentifier(column, 'column'); } catch { fail(path, 'column must be a plain identifier'); }
      if (SQL_RESERVED.has(column.toLowerCase())) fail(path, `column ${column} is a reserved SQL word: choose another field name or set \`column\` explicitly`);
      const flag = (k) => (t.secret && ['listable', 'sortable', 'filterable', 'searchable'].includes(k) ? false : (f[k] ?? t[k]));
      if (t.secret) for (const k of ['listable', 'sortable', 'filterable', 'searchable']) if (f[k] === true) fail(path, `a secret field cannot be ${k}`);
      for (const k of ['sortable', 'filterable', 'searchable']) if (f[k] === true && t[k] === false && !t.secret) fail(path, `type ${f.type} cannot be ${k}`);
      taken.add(fname);
      out[fname] = Object.freeze({
        ...f, name: fname, column, def: t, sqlType: columnOf(t, f),
        required: f.required === true, nullable: f.nullable === true, secret: t.secret === true,
        listable: flag('listable'), sortable: flag('sortable'), filterable: flag('filterable'), searchable: flag('searchable'),
      });
    }
    return out;
  };

  const baseTaken = new Set();
  const fields = compileFields(def.fields, '', baseTaken);
  if (Object.keys(fields).length === 0) fail('fields', 'at least one field is required');
  const columnsSeen = new Set();
  for (const f of Object.values(fields)) { if (columnsSeen.has(f.column)) fail(f.name, `column ${f.column} is used twice`); columnsSeen.add(f.column); }

  // Variants: a set of extra fields that depends on the value of one field (e.g. the device type); stored together in the `attrs` JSON column.
  let variants = null;
  if (def.variants !== undefined) {
    const v = def.variants;
    const by = fields[v?.by];
    if (!by || !['enum', 'text'].includes(by.type)) fail('variants.by', 'must name an enum or text field of this entity');
    if (!isObj(v.cases) || Object.keys(v.cases).length === 0) fail('variants.cases', 'at least one case is required');
    const cases = Object.create(null); // no inherited names: a request value like "constructor" must not find anything
    for (const [key, c] of Object.entries(v.cases)) {
      if (by.type === 'enum' && !by.values.includes(key)) fail(`variants.cases.${key}`, `not a value of ${by.name}`);
      cases[key] = Object.freeze({ fields: compileFields(c.fields, `variants.${key}.`, new Set(baseTaken)) });
    }
    variants = Object.freeze({ by: v.by, cases: Object.freeze(cases) });
  }

  const permissions = { ...(def.permissions ?? {}) };
  const features = { ...FEATURES };
  for (const [k, val] of Object.entries(def.features ?? {})) {
    if (!(k in FEATURES)) fail(`features.${k}`, 'unknown feature');
    features[k] = val === true;
  }
  for (const act of ['read', 'create', 'update', 'delete', ...(features.softDelete ? ['restore'] : [])]) {
    if (typeof permissions[act] !== 'string' || !/^[a-z][a-zA-Z0-9_.-]*$/.test(permissions[act])) fail(`permissions.${act}`, 'a permission name is required (there is no "everyone" default)');
  }
  Object.freeze(permissions);

  const sortable = new Set(['id', 'createdAt', 'updatedAt', ...Object.values(fields).filter((f) => f.sortable).map((f) => f.name)]);
  const list = {
    columns: def.list?.columns ?? Object.values(fields).filter((f) => f.listable).slice(0, 6).map((f) => f.name),
    sort: def.list?.sort ?? ['-createdAt'],
    pageSize: def.list?.pageSize ?? 25,
  };
  for (const c of list.columns) if (!fields[c] || !fields[c].listable) fail('list.columns', `${JSON.stringify(c)} is not a listable field`);
  for (const s of list.sort) if (!sortable.has(String(s).replace(/^-/, ''))) fail('list.sort', `${JSON.stringify(s)} is not a sortable field`);
  if (!Number.isInteger(list.pageSize) || list.pageSize < 1 || list.pageSize > 200) fail('list.pageSize', 'must be an integer from 1 to 200');

  const checkSets = (key) => (def[key] ?? []).map((cols, i) => {
    if (!Array.isArray(cols) || cols.length === 0) fail(`${key}[${i}]`, 'must be a non-empty list of field names');
    for (const c of cols) if (!fields[c]) fail(`${key}[${i}]`, `unknown field ${JSON.stringify(c)}`);
    return Object.freeze([...cols]);
  });
  const unique = [...checkSets('unique'), ...Object.values(fields).filter((f) => f.unique === true).map((f) => Object.freeze([f.name]))];
  const index = checkSets('index');

  const hooks = {};
  for (const [k, fn] of Object.entries(def.hooks ?? {})) {
    if (!HOOKS.has(k)) fail(`hooks.${k}`, `unknown hook (allowed: ${[...HOOKS].join(', ')})`);
    if (typeof fn !== 'function') fail(`hooks.${k}`, 'must be a function');
    hooks[k] = fn;
  }

  const baseFields = Object.values(fields);
  const variantFieldsFor = (key) => (variants && variants.cases[key] ? Object.values(variants.cases[key].fields) : []);

  function checkValue(f, value, errors, out, pathPrefix = '') {
    const path = `${pathPrefix}${f.name}`;
    if (value === null) {
      if (f.nullable && !f.required) { out[f.name] = null; return; }
      errors.push({ path, code: f.required ? 'required' : 'null_not_allowed' });
      return;
    }
    const r = f.def.validate(value, f);
    if (r.ok) out[f.name] = r.value;
    else errors.push({ path, code: r.code, ...(r.params ? { params: r.params } : {}) });
  }

  /**
   * Checks an input object. `mode`: 'create' (defaults applied, required fields must be present) or 'update' (only the given fields).
   * For an update of a variant entity pass `current` (the stored record) so the case can be resolved when the input does not repeat it.
   * @returns {{ok: boolean, value: object, errors: {path:string, code:string, params?:object}[]}}
   */
  function validate(input, { mode = 'create', current } = {}) {
    const errors = []; const base = {};
    if (!isObj(input)) return { ok: false, value: {}, errors: [{ path: '', code: 'type', params: { expected: 'object' } }] };
    const known = new Set(baseFields.map((f) => f.name));
    const caseKey = variants ? (input[variants.by] ?? current?.[variants.by]) : undefined;
    const vFields = variantFieldsFor(caseKey);
    for (const f of vFields) known.add(f.name);
    for (const k of Object.keys(input)) if (!known.has(k)) errors.push({ path: k, code: variants && Object.values(variants.cases).some((c) => c.fields[k]) ? 'not_for_this_case' : 'unknown_field' });

    const run = (list, out, prefix) => {
      for (const f of list) {
        if (f.readOnly === true && input[f.name] !== undefined) { errors.push({ path: f.name, code: 'read_only' }); continue; }
        const given = input[f.name];
        if (given === undefined) {
          if (mode === 'create') {
            if (f.default !== undefined) out[f.name] = typeof f.default === 'function' ? f.default() : f.default;
            else if (f.required) errors.push({ path: f.name, code: 'required' });
          }
          continue;
        }
        checkValue(f, given, errors, out, prefix);
      }
    };
    run(baseFields, base, '');
    const attrs = {};
    if (variants) {
      run(vFields, attrs, ''); // a value without a case has no extra fields (not an error by itself)
      if (Object.keys(attrs).length > 0) base.attrs = attrs;
    }
    return { ok: errors.length === 0, value: base, errors };
  }

  const storedName = (f) => f.column;
  /** API object -> row with column names and stored values (booleans 1/0, JSON text, `attrs` as JSON text). */
  function toStorage(value) {
    const row = {};
    for (const f of baseFields) {
      if (!(f.name in value)) continue;
      const v = value[f.name];
      row[storedName(f)] = v === null || v === undefined ? null : (f.def.toStorage ? f.def.toStorage(v, f) : v);
    }
    if (variants && value.attrs !== undefined) row.attrs = JSON.stringify(value.attrs);
    return row;
  }
  /** Stored row -> API object (secret fields stay as stored, i.e. encrypted: use `publicShape` before sending). */
  function fromStorage(row) {
    const out = { id: row.id };
    for (const f of baseFields) {
      if (!(f.column in row)) continue;
      const v = row[f.column];
      out[f.name] = v === null || v === undefined ? null : (f.def.fromStorage ? f.def.fromStorage(v, f) : v);
    }
    if (variants) out.attrs = row.attrs ? JSON.parse(row.attrs) : {};
    for (const k of ['created_at', 'updated_at', 'deleted_at', 'version', 'tenant_id']) if (k in row) out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = row[k];
    return out;
  }
  /** The record without secret fields (also inside `attrs`): what lists, exports, history and API answers may carry. */
  function publicShape(record) {
    const out = { ...record };
    for (const f of baseFields) if (f.secret) delete out[f.name];
    if (variants && out.attrs) {
      const a = { ...out.attrs };
      for (const f of variantFieldsFor(record[variants.by])) if (f.secret) delete a[f.name];
      out.attrs = a;
    }
    return out;
  }

  /** CREATE TABLE and index statements in the common dialect (run them through `translate(sql, dialect)` for PostgreSQL). */
  /** The columns of the table, in order: `{ name, sql, notNull, hasDefault }` (`sql` is the full column definition). */
  function columns() {
    const out = [];
    const add = (name, sql, notNull = false, hasDefault = false) => out.push(Object.freeze({ name, sql, notNull, hasDefault }));
    if (idType === 'text') add('id', 'id TEXT PRIMARY KEY', true); else add('id', 'id INTEGER PRIMARY KEY AUTOINCREMENT', true);
    if (tenant === 'tenant') add('tenant_id', 'tenant_id TEXT NOT NULL', true);
    for (const f of baseFields) { const nn = Boolean(f.required && !f.nullable); add(f.column, `${f.column} ${f.sqlType}${nn ? ' NOT NULL' : ''}`, nn); }
    if (variants) add('attrs', 'attrs TEXT');
    add('created_at', 'created_at TEXT NOT NULL', true); add('updated_at', 'updated_at TEXT NOT NULL', true);
    if (features.optimisticLock) add('version', 'version INTEGER NOT NULL DEFAULT 1', true, true);
    if (features.softDelete) add('deleted_at', 'deleted_at TEXT');
    return Object.freeze(out);
  }

  function ddl({ ifNotExists = true } = {}) {
    const ine = ifNotExists ? 'IF NOT EXISTS ' : '';
    const lines = columns().map((c) => c.sql);
    const stmts = [`CREATE TABLE ${ine}${def.table} (\n  ${lines.join(',\n  ')}\n)`];
    const cols = (names) => names.map((n) => fields[n].column);
    const idxName = (prefix, cs) => {
      const n = `${prefix}_${def.table}_${cs.join('_')}`;
      if (n.length > 63) fail('index', `index name ${n} is longer than 63 characters (PostgreSQL limit): use fewer or shorter columns`);
      return n;
    };
    const where = features.softDelete ? ' WHERE deleted_at IS NULL' : '';
    for (const u of unique) {
      const cs = [...(tenant === 'tenant' ? ['tenant_id'] : []), ...cols(u)];
      stmts.push(`CREATE UNIQUE INDEX ${ine}${idxName('ux', cs)} ON ${def.table} (${cs.join(', ')})${where}`);
    }
    for (const i of index) {
      const cs = [...(tenant === 'tenant' ? ['tenant_id'] : []), ...cols(i)];
      stmts.push(`CREATE INDEX ${ine}${idxName('idx', cs)} ON ${def.table} (${cs.join(', ')})`);
    }
    if (tenant === 'tenant') stmts.push(`CREATE INDEX ${ine}${idxName('idx', ['tenant_id'])} ON ${def.table} (tenant_id)`);
    return stmts;
  }

  return Object.freeze({
    name, table: def.table, label: Object.freeze({ ru: Object.freeze([...def.label.ru]), en: Object.freeze([...def.label.en]) }),
    tenant, idType, fields: Object.freeze(fields), variants, permissions, features: Object.freeze(features),
    list: Object.freeze({ ...list, columns: Object.freeze([...list.columns]), sort: Object.freeze([...list.sort]) }),
    unique: Object.freeze(unique), index: Object.freeze(index), hooks: Object.freeze(hooks),
    validate, toStorage, fromStorage, publicShape, ddl, columns,
  });
}

/**
 * A set of entities: names and tables are unique, and every `ref` points to an entity of the set or to one named in `external`
 * (entities of the core, e.g. 'users').
 */
export function defineEntities(list, { external = ['users'] } = {}) {
  const byName = new Map(); const tables = new Set();
  for (const e of list) {
    if (byName.has(e.name)) throw new EntityDefinitionError(e.name, '', 'duplicate entity name');
    if (tables.has(e.table)) throw new EntityDefinitionError(e.name, 'table', `table ${e.table} is used by another entity`);
    byName.set(e.name, e); tables.add(e.table);
  }
  for (const e of list) {
    const all = [...Object.values(e.fields), ...(e.variants ? Object.values(e.variants.cases).flatMap((c) => Object.values(c.fields)) : [])];
    for (const f of all) {
      if (f.type !== 'ref') continue;
      if (!byName.has(f.entity) && !external.includes(f.entity)) throw new EntityDefinitionError(e.name, f.name, `ref to unknown entity ${JSON.stringify(f.entity)}`);
    }
  }
  return Object.freeze({ entities: Object.freeze([...list]), get: (n) => byName.get(n), ddl: () => list.flatMap((e) => e.ddl()) });
}
