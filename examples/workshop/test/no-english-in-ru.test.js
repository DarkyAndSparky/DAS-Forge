import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderRealtimeBody } from '../src/pages.js';
import { renderHomeBody } from '../src/routes.js';

/** Visible words of a rendered page: no scripts, styles, tags, code or preformatted blocks. */
const visible = (html) => html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<code>[\s\S]*?<\/code>|<pre[\s\S]*?<\/pre>/g, ' ')
  .replace(/<[^>]*\splaceholder="([^"]*)"[^>]*>/g, ' $1 ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\b[a-z]+\.[a-z]+\b/g, ' '); // identifiers such as auth.login

const ENGLISH = /\b(the|and|your|you|password|account|sign|please|wrong|failed|enter|saved|remove|delete|search|create|back|users?|backup|backups|login|role|disabled|enable|code|send|message|filter|actor|action|result|health|status)\b/i;

const user = { username: 'ann', permissions: ['admin:write', 'admin.access'] };
const pages = {
  realtime: renderRealtimeBody({ locale: 'ru' }),
  home: renderHomeBody(user, 'ru'),
};

describe('Russian pages carry no English words in their visible text', () => {
  for (const [name, html] of Object.entries(pages)) {
    it(name, () => {
      const words = visible(html).match(ENGLISH);
      expect(words, `${name}: ${words?.[0]}`).toBeNull();
    });
  }
});

describe('the workshop has one translation mechanism', () => {
  it('no source file imports the old dictionary', () => {
    const dir = fileURLToPath(new URL('../src/', import.meta.url));
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) expect(readFileSync(dir + f, 'utf8'), f).not.toMatch(/\/i18n\.js'|localizeHtml|localizeText/);
  });
});
