import { describe, it, expect } from 'vitest';
import { renderLoginPage } from '../src/accounts/pages.js';
import { BASE_CSS } from '../src/ui/theme.js';
import { readFileSync } from 'node:fs';

const attrs = (html, id) => new RegExp(`<input id="${id}"[^>]*>`).exec(html)?.[0] ?? '';

describe('login page fields (phone keyboards, ADR: proposals G1)', () => {
  it('does not capitalise or spell-check the login, labels Enter on the last field and keeps the autocomplete hints', () => {
    const html = renderLoginPage({ l: {} });
    const user = attrs(html, 'username');
    expect(user).toContain('autocapitalize="off"');
    expect(user).toContain('spellcheck="false"');
    expect(user).toContain('autocomplete="username"');
    expect(attrs(html, 'password')).toContain('autocomplete="current-password"');
    expect(attrs(html, 'password')).toContain('enterkeyhint="go"');
    expect(attrs(html, 'password')).not.toContain('spellcheck');
    expect(attrs(html, 'code')).toContain('autocomplete="one-time-code"');
  });
});

describe('hidden elements', () => {
  it('the stylesheet makes the hidden attribute win over display rules', () => {
    expect(BASE_CSS).toContain('[hidden]{display:none!important}');
  });
});

describe('admin forms (source check)', () => {
  const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  it('ban value, new user and search fields carry the keyboard hints', () => {
    expect(src('admin/sections.js')).toMatch(/name="value" required maxlength="64" autocapitalize="off"[^>]*spellcheck="false"[^>]*translate="no"/);
    expect(src('admin/sections-users.js')).toMatch(/name="username" required minlength="3" maxlength="64" autocapitalize="off"/);
    expect(src('admin/index.js')).toMatch(/type="search" name="q"[^>]*enterkeyhint="search"/);
  });
  it('G3: a dangerous confirmation puts focus on Cancel, never on the confirm button', () => {
    expect(src('admin/sections-users.js')).toContain('class="adm-btn adm-cancel" autofocus');
    expect(src('ui/modal.js')).toContain('(input||(o.danger&&c?c:ok)).focus()');
  });
});
