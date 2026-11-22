import { describe, it, expect } from 'vitest';
import { defineEntity, field, jsonSchemaOf, typeScriptOf, openApiOf } from '../src/entities/index.js';

const e = defineEntity({ name: 'asset', table: 'assets', idType: 'text', label: { ru: ['Актив', 'Активы'], en: ['Asset', 'Assets'] },
  permissions: { read: 'r', create: 'w', update: 'w', delete: 'd', restore: 'd' },
  fields: { title: field.text({ required: true, max: 30 }), price: field.money({ nullable: true, min: 0 }), kind: field.enum(['laptop', 'router'], { nullable: true }), pass: field.secret({ nullable: true }), owner: field.ref('users', { idType: 'int', nullable: true }) },
  variants: { by: 'kind', cases: { router: { fields: { ip: field.ip({ required: true }) } }, laptop: { fields: { host: field.text() } } } },
  features: { softDelete: true } });

describe('generated descriptions', () => {
  it('record: no secrets, id, tenant, timestamps, version', () => {
    const s = jsonSchemaOf(e, 'record');
    expect(Object.keys(s.properties).includes('pass')).toBe(false);
    for (const k of ['id', 'tenantId', 'title', 'attrs', 'createdAt', 'version', 'deletedAt']) expect(k in s.properties).toBe(true);
    expect(s.required.includes('title')).toBe(true);
  });
  it('create: required without a default, closed set, secret write-only, nullable kinds, variant cases', () => {
    const s = jsonSchemaOf(e, 'create');
    expect(s.required).toEqual(['title']);
    expect(s.unevaluatedProperties).toBe(false);
    expect(s.properties.pass.writeOnly).toBe(true);
    expect(s.properties.title.maxLength).toBe(30);
    expect(s.properties.price).toEqual({ type: ['integer', 'null'], description: 'minor units (e.g. cents)', minimum: 0 });
    expect(s.properties.kind.enum).toEqual(['laptop', 'router', null]);
    const router = s.allOf.find((x) => x.if.properties.kind.const === 'router');
    expect(router.then.required).toEqual(['ip']);
  });
  it('TypeScript text', () => {
    const t = typeScriptOf([e]);
    expect(t).toContain('export interface Asset {');
    expect(t).toContain('title: string;');
    expect(t).toContain('price?: number | null;');
    expect(t).toContain('kind?: "laptop" | "router" | null;');
    expect(t).toContain('export type AssetInput =');
    expect(t.split('export interface Asset {')[1].split('}')[0]).not.toContain('pass');
  });
  it('OpenAPI: the routes of mountEntityApi, errors, restore only with soft delete', () => {
    const d = openApiOf([e], { title: 'T', security: { cookieAuth: [] }, securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: 'sid' } } });
    expect(d.openapi).toBe('3.1.0');
    expect(Object.keys(d.paths).sort()).toEqual(['/api/assets', '/api/assets/{id}', '/api/assets/{id}/restore']);
    expect(Object.keys(d.paths['/api/assets/{id}'])).toContain('patch');
    expect(d.paths['/api/assets'].post.responses[422]).toBeTruthy();
    expect(d.paths['/api/assets'].get.security).toEqual([{ cookieAuth: [] }]);
    expect(Object.keys(d.components.schemas).sort()).toEqual(['Asset', 'AssetCreate', 'AssetUpdate', 'Error']);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d); // pure data
  });
});
