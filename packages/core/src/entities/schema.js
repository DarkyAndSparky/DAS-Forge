/**
 * Descriptions of an entity for the outside world, generated from the descriptor (ADR-0012, D1): JSON Schema (draft 2020-12, the
 * dialect of OpenAPI 3.1), TypeScript types and an OpenAPI document for the JSON interface of `mountEntityApi`. The descriptor stays
 * the only source of truth, so nothing here can disagree with `entity.validate`. Pure functions, no dependencies.
 *
 *   jsonSchemaOf(entity, 'record' | 'create' | 'update')
 *   typeScriptOf(entities)         // source text of a .d.ts
 *   openApiOf(entities, { title, version, basePath: (entity) => '/api/…' })
 *
 * Not expressed: custom types registered with `registerFieldType` (shown as an empty schema), `min`/`max` of a custom check, hooks.
 */

const isObj = (v) => typeof v === 'object' && v !== null;

function fieldSchema(f) {
  let s;
  switch (f.type) {
    case 'text': case 'longText': s = { type: 'string', maxLength: f.max ?? (f.type === 'text' ? 255 : 20_000), ...(f.min !== undefined ? { minLength: f.min } : {}), ...(f.pattern ? { pattern: f.pattern.source } : {}) }; break;
    case 'int': s = { type: 'integer', ...(f.min !== undefined ? { minimum: f.min } : {}), ...(f.max !== undefined ? { maximum: f.max } : {}) }; break;
    case 'decimal': s = { type: 'string', pattern: '^-?\\d+(\\.\\d+)?$', description: `decimal with up to ${f.scale ?? 2} fraction digits` }; break;
    case 'money': s = { type: 'integer', description: `minor units (e.g. cents)${f.currency ? `, ${f.currency}` : ''}`, ...(f.min !== undefined ? { minimum: f.min } : {}), ...(f.max !== undefined ? { maximum: f.max } : {}) }; break;
    case 'bool': s = { type: 'boolean' }; break;
    case 'date': s = { type: 'string', format: 'date' }; break;
    case 'datetime': s = { type: 'string', format: 'date-time' }; break;
    case 'enum': s = { type: 'string', enum: [...f.values] }; break;
    case 'ref': s = f.idType === 'text' ? { type: 'string', maxLength: 64 } : { type: 'integer', minimum: 1 }; s.description = `id of ${f.entity}`; break;
    case 'json': s = {}; break;
    case 'file': s = { type: 'string', maxLength: 64, description: 'file id' }; break;
    case 'secret': s = { type: 'string', minLength: 1, maxLength: f.max ?? 1024, writeOnly: true }; break;
    case 'ip': s = { type: 'string', description: 'IPv4 or IPv6 address' }; break;
    case 'mac': s = { type: 'string', pattern: '^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}$' }; break;
    default: s = {};
  }
  if (f.nullable) {
    if (s.enum) s = { ...s, enum: [...s.enum, null], type: ['string', 'null'] };
    else if (typeof s.type === 'string') s = { ...s, type: [s.type, 'null'] };
    else s = { anyOf: [s, { type: 'null' }] };
  }
  return s;
}

const publicFields = (entity) => Object.values(entity.fields);
const caseEntries = (entity) => (entity.variants ? Object.entries(entity.variants.cases) : []);

/** @param {'record'|'create'|'update'} shape */
export function jsonSchemaOf(entity, shape = 'record') {
  const properties = {}; const required = [];
  const base = shape === 'record' ? publicFields(entity).filter((f) => !f.secret) : publicFields(entity);
  const writable = (f) => f.readOnly !== true;
  if (shape === 'record') {
    properties.id = entity.idType === 'int' ? { type: 'integer' } : { type: 'string' };
    required.push('id');
    if (entity.tenant === 'tenant') { properties.tenantId = { type: 'string' }; required.push('tenantId'); }
  }
  for (const f of base) {
    if (shape !== 'record' && !writable(f)) continue;
    properties[f.name] = fieldSchema(f);
    if (shape === 'create' && f.required && f.default === undefined) required.push(f.name);
    if (shape === 'record' && f.required && !f.nullable) required.push(f.name);
  }
  const out = { type: 'object', title: entity.label.en[0], properties };
  if (shape === 'record') {
    if (entity.variants) properties.attrs = { type: 'object', description: 'fields of the chosen kind', additionalProperties: true };
    Object.assign(properties, { createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } });
    required.push('createdAt', 'updatedAt');
    if (entity.features.optimisticLock) { properties.version = { type: 'integer', minimum: 1 }; required.push('version'); }
    if (entity.features.softDelete) properties.deletedAt = { type: ['string', 'null'], format: 'date-time' };
  } else {
    out.unevaluatedProperties = false;
    if (entity.variants) {
      out.allOf = caseEntries(entity).map(([key, c]) => ({
        if: { properties: { [entity.variants.by]: { const: key } }, required: [entity.variants.by] },
        then: { properties: Object.fromEntries(Object.values(c.fields).filter(writable).map((f) => [f.name, fieldSchema(f)])), ...(shape === 'create' ? { required: Object.values(c.fields).filter((f) => f.required && f.default === undefined).map((f) => f.name) } : {}) },
      })).filter((x) => x.then.required === undefined || x.then.required.length > 0 || Object.keys(x.then.properties).length > 0);
    }
  }
  if (required.length) out.required = required;
  return out;
}

const tsType = (f) => {
  let t;
  switch (f.type) {
    case 'text': case 'longText': case 'decimal': case 'date': case 'datetime': case 'file': case 'ip': case 'mac': case 'secret': t = 'string'; break;
    case 'int': case 'money': t = 'number'; break;
    case 'bool': t = 'boolean'; break;
    case 'enum': t = f.values.map((v) => JSON.stringify(v)).join(' | '); break;
    case 'ref': t = f.idType === 'text' ? 'string' : 'number'; break;
    case 'json': t = 'unknown'; break;
    default: t = 'unknown';
  }
  return f.nullable ? `${t} | null` : t;
};

const pascal = (s) => s.replace(/(^|[-_ ])(\w)/g, (_, __, c) => c.toUpperCase());

/** Source text of TypeScript declarations: `<Name>` (a record) and `<Name>Input` (create/update body) for every entity. */
export function typeScriptOf(entities) {
  const list = Array.isArray(entities) ? entities : entities.entities;
  const out = ['// Generated from the entity descriptors. Do not edit.\n'];
  for (const e of list) {
    const N = pascal(e.name);
    const idT = e.idType === 'int' ? 'number' : 'string';
    const rec = [`  id: ${idT};`];
    if (e.tenant === 'tenant') rec.push('  tenantId: string;');
    for (const f of publicFields(e)) if (!f.secret) rec.push(`  ${f.name}${f.required && !f.nullable ? '' : '?'}: ${tsType(f)};`);
    if (e.variants) rec.push('  attrs?: Record<string, unknown>;');
    rec.push('  createdAt: string;', '  updatedAt: string;');
    if (e.features.optimisticLock) rec.push('  version: number;');
    if (e.features.softDelete) rec.push('  deletedAt?: string | null;');
    out.push(`export interface ${N} {\n${rec.join('\n')}\n}\n`);
    const inp = publicFields(e).filter((f) => f.readOnly !== true).map((f) => `  ${f.name}${f.required && f.default === undefined ? '' : '?'}: ${tsType(f)};`);
    if (e.variants) {
      const cases = caseEntries(e).map(([key, c]) => `{ ${e.variants.by}: ${JSON.stringify(key)}; ${Object.values(c.fields).filter((f) => f.readOnly !== true).map((f) => `${f.name}${f.required && f.default === undefined ? '' : '?'}: ${tsType(f)};`).join(' ')} }`);
      if (!e.fields[e.variants.by].required) cases.push(`{ ${e.variants.by}?: null }`); // no kind chosen: no extra fields
      out.push(`export type ${N}Input = {\n${inp.filter((l) => !l.includes(`  ${e.variants.by}`)).join('\n')}\n} & (${cases.join(' | ')});\n`);
    } else out.push(`export interface ${N}Input {\n${inp.join('\n')}\n}\n`);
  }
  return out.join('\n');
}

const errorResponse = (description) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });

/**
 * An OpenAPI 3.1 document for the routes of `mountEntityApi`. `basePath(entity)` must match the path given to `mountEntityApi`
 * (default `/api/<table>`). Authentication is the application's: pass `security` (e.g. `{ cookieAuth: [] }`) and `securitySchemes`.
 */
export function openApiOf(entities, { title = 'API', version = '1.0.0', basePath = (e) => `/api/${e.table}`, security, securitySchemes } = {}) {
  const list = Array.isArray(entities) ? entities : entities.entities;
  const paths = {}; const schemas = {
    Error: { type: 'object', properties: { error: { type: 'string' }, errors: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, code: { type: 'string' }, params: { type: 'object' } }, required: ['path', 'code'] } }, message: { type: 'string' } }, required: ['error'] },
  };
  const sec = security ? { security: [security] } : {};
  for (const e of list) {
    const N = pascal(e.name); const base = basePath(e);
    schemas[N] = jsonSchemaOf(e, 'record'); schemas[`${N}Create`] = jsonSchemaOf(e, 'create'); schemas[`${N}Update`] = jsonSchemaOf(e, 'update');
    const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
    const json = (schema) => ({ 'application/json': { schema } });
    const idParam = { name: 'id', in: 'path', required: true, schema: e.idType === 'int' ? { type: 'integer' } : { type: 'string' } };
    const tag = [e.label.en[1]];
    const common = { 401: errorResponse('Not signed in'), 403: errorResponse('No right') };
    paths[base] = {
      get: { tags: tag, summary: `List ${e.label.en[1]}`, ...sec, parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } }, { name: 'size', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
        { name: 'sort', in: 'query', description: 'comma separated field names, "-" before a name = descending', schema: { type: 'string' } },
        { name: 'q', in: 'query', description: 'search in the searchable fields', schema: { type: 'string' } },
        { name: 'filter', in: 'query', description: 'filter[field]=value, filterable fields only', style: 'deepObject', explode: true, schema: { type: 'object', additionalProperties: true } },
        ...(e.features.softDelete ? [{ name: 'includeDeleted', in: 'query', schema: { type: 'string', enum: ['1'] } }] : []),
      ], responses: { 200: { description: 'A page', content: json({ type: 'object', properties: { items: { type: 'array', items: ref(N) }, total: { type: 'integer' }, page: { type: 'integer' }, size: { type: 'integer' } }, required: ['items', 'total'] }) }, 400: errorResponse('Bad query'), ...common } },
      post: { tags: tag, summary: `Create ${e.label.en[0]}`, ...sec, requestBody: { required: true, content: json(ref(`${N}Create`)) }, responses: { 201: { description: 'Created', content: json(ref(N)) }, 400: errorResponse('No organization chosen'), 409: errorResponse('Conflict'), 422: errorResponse('Invalid'), ...common } },
    };
    paths[`${base}/{id}`] = {
      parameters: [idParam],
      get: { tags: tag, summary: `Get ${e.label.en[0]}`, ...sec, responses: { 200: { description: 'The record', content: json(ref(N)) }, 404: errorResponse('Not found'), ...common } },
      patch: { tags: tag, summary: `Change ${e.label.en[0]}`, ...sec, parameters: e.features.optimisticLock ? [{ name: 'If-Match', in: 'header', schema: { type: 'string' }, description: 'expected version' }] : [], requestBody: { required: true, content: json(ref(`${N}Update`)) }, responses: { 200: { description: 'Changed', content: json(ref(N)) }, 404: errorResponse('Not found'), 409: errorResponse('Version or uniqueness conflict'), 422: errorResponse('Invalid'), ...common } },
      delete: { tags: tag, summary: `Delete ${e.label.en[0]}`, ...sec, responses: { 204: { description: 'Deleted' }, 404: errorResponse('Not found'), ...common } },
    };
    if (e.features.softDelete) paths[`${base}/{id}/restore`] = { parameters: [idParam], post: { tags: tag, summary: `Restore ${e.label.en[0]}`, ...sec, responses: { 200: { description: 'Restored', content: json(ref(N)) }, 404: errorResponse('Not found'), 409: errorResponse('Uniqueness conflict'), ...common } } };
  }
  return { openapi: '3.1.0', info: { title, version }, paths, components: { schemas, ...(isObj(securitySchemes) ? { securitySchemes } : {}) } };
}
