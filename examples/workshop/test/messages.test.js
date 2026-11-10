import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MESSAGES, translator, missingMessages, scriptTexts } from '../src/messages.js';
import { renderRealtimeBody } from '../src/pages.js';

const pagesSrc = readFileSync(fileURLToPath(new URL('../src/pages.js', import.meta.url)), 'utf8');

const flatten = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? flatten(v, `${p}${k}.`) : [`${p}${k}`]));

describe('message catalogue', () => {
  it('has the same keys in both languages and no empty text', () => {
    expect(missingMessages()).toEqual([]);
    expect(flatten(MESSAGES.ru).sort()).toEqual(flatten(MESSAGES.en).sort());
  });

  it('every key the pages ask for exists', () => {
    const t = translator('en');
    const used = new Set([...pagesSrc.matchAll(/\b(?:x|t)\('((?:realtime|home|reports)\.[A-Za-z_]+)'\)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(5);
    for (const k of used) expect(t(k), k).not.toBe(k);
  });

  it('scriptTexts cannot end a script element', () => {
    const s = scriptTexts({ a: '</script><!--', b: ' ' });
    expect(s).not.toContain('<');
    expect(JSON.parse(s)).toEqual({ a: '</script><!--', b: ' ' });
  });
});

describe('realtime page follows the locale', () => {
  it('Russian render has Russian words and no English leftovers in its script', () => {
    const r = renderRealtimeBody({ locale: 'ru', nonce: 'n' });
    expect(r).toContain('Лаборатория реального времени');
    const script = [...r.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    for (const phrase of ['Could not send', 'connection lost']) expect(script).not.toContain(phrase);
    expect(() => JSON.parse(/const T = (\{.*\});/.exec(r)[1])).not.toThrow();
  });
});
