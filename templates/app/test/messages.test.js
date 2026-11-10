import { describe, it, expect } from 'vitest';
import { MESSAGES, missingMessages, translator, scriptTexts } from '../src/messages.js';
import { renderHomeBody, renderNotesBody } from '../src/pages.js';

const flatten = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? flatten(v, `${p}${k}.`) : [`${p}${k}`]));
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');
const ENGLISH = /\b(the|and|your|password|sign|please|wrong|delete|add|back|admin)\b/i;

describe('texts', () => {
  it('both languages have the same keys and no key is missing', () => {
    expect(missingMessages()).toEqual([]);
    expect(flatten(MESSAGES.ru).sort()).toEqual(flatten(MESSAGES.en).sort());
  });

  it('an unknown language falls back to Russian, a known key never comes back as itself', () => {
    expect(translator('de')('notes.title')).toBe(translator('ru')('notes.title'));
    for (const k of flatten(MESSAGES.en)) expect(translator('en')(k), k).not.toBe(k);
  });

  it('scriptTexts cannot end a script element', () => {
    const s = scriptTexts({ a: '</script><!--' });
    expect(s).not.toContain('<');
    expect(JSON.parse(s)).toEqual({ a: '</script><!--' });
  });
});

describe('pages follow the language', () => {
  const user = { username: 'ann', permissions: ['read:notes', 'write:notes', 'admin.access'] };
  const ru = {
    home: renderHomeBody(user, 'ru'),
    notes: renderNotesBody({ locale: 'ru', nonce: 'n', canWrite: true }),
  };

  it('Russian pages carry no English words in their visible text', () => {
    for (const [name, html] of Object.entries(ru)) expect(visible(html).match(ENGLISH), name).toBeNull();
  });

  it('the notes page shows the form only to someone who may write, and escapes the user name', () => {
    expect(renderNotesBody({ locale: 'en', canWrite: false })).not.toContain('<form id="noteForm"');
    expect(renderNotesBody({ locale: 'en', canWrite: true })).toContain('<form id="noteForm"');
    expect(renderHomeBody({ username: '<b>x</b>', permissions: [] }, 'en')).not.toContain('<b>x</b>');
  });
});
