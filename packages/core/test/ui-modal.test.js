import { describe, it, expect } from 'vitest';
import { MODAL_SCRIPT } from '../src/ui/modal.js';
import { renderAppShell } from '../src/ui/shell.js';
import { themeHead } from '../src/ui/theme.js';

describe('modal dialogs', () => {
  it('the script parses and exposes admDialog.alert/confirm/prompt and data-confirm', () => {
    expect(() => new Function(MODAL_SCRIPT)).not.toThrow();
    for (const s of ['admDialog', 'alert:', 'confirm:', 'prompt:', 'data-confirm', 'showModal']) expect(MODAL_SCRIPT).toContain(s);
  });
  it('text is set through textContent, never innerHTML', () => {
    expect(MODAL_SCRIPT).not.toContain('innerHTML');
  });
  it('the shell loads the script (with the CSP nonce) and keeps the footer inside the main column', () => {
    const html = renderAppShell({ moduleRegistry: { getNavigation: () => [], getTranslations: () => ({ ru: {}, en: {} }) }, nonce: 'N1', bodyEndHtml: '<i id="x"></i>' });
    expect(html).toContain('<script nonce="N1">(function(){');
    expect(html.indexOf('id="x"') < html.indexOf('</div>\n<script')).toBe(true);
    expect(html).toContain('class="adm-foot"');
  });
  it('the stylesheet styles dialogs and plain form controls inside the content area', () => {
    const css = themeHead({});
    expect(css).toContain('dialog.adm-dialog');
    expect(css).toContain('.adm-content button');
    expect(css).toContain('.adm-content input:not(');
  });
});

describe('chart label that follows the pointer', () => {
  it('the page script builds a tooltip for chart hit areas and the theme styles it', () => {
    expect(MODAL_SCRIPT).toContain("adm-tip");
    expect(MODAL_SCRIPT).toContain("svg .adm-hit");
    expect(themeHead({})).toContain('.adm-tip{');
  });
});

describe('double submit guard (G-05)', () => {
  // the script run against a tiny stand-in for the page: only what the guard touches
  function load() {
    const handlers = {};
    const document = { documentElement: { lang: 'en' }, addEventListener: (t, f) => { (handlers[t] ??= []).push(f); }, querySelectorAll: () => [] };
    const timers = [];
    const win = { addEventListener: (t, f) => { (handlers['w:' + t] ??= []).push(f); } };
    new Function('document', 'window', 'setTimeout', MODAL_SCRIPT)(document, win, (fn, ms) => timers.push({ fn, ms }));
    const submit = (form, extra = {}) => { const e = { target: form, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra }; handlers.submit.forEach((h) => h(e)); return e; };
    return { submit, timers };
  }
  const makeForm = (over = {}) => { const btn = { disabled: false }; return { method: 'post', dataset: {}, btn, querySelectorAll: () => [btn], ...over }; };

  it('the first submit goes through and disables the buttons after the browser has collected the form', () => {
    const { submit, timers } = load();
    const f = makeForm();
    expect(submit(f).defaultPrevented).toBe(false);
    expect(f.btn.disabled).toBe(false); // not yet: the submitter button must still be part of the data
    timers.find((t) => t.ms === 0).fn();
    expect(f.btn.disabled).toBe(true);
  });

  it('a second submit of the same form within 8 s is swallowed; after 8 s the buttons are unlocked', () => {
    const { submit, timers } = load();
    const f = makeForm();
    submit(f);
    expect(submit(f).defaultPrevented).toBe(true);
    timers.find((t) => t.ms === 8000).fn();
    expect(f.btn.disabled).toBe(false);
    expect(f.dataset.sent).toBe(undefined);
  });

  it('leaves alone GET forms, forms that handle their own submit, and data-multi forms', () => {
    const { submit } = load();
    for (const f of [makeForm({ method: 'get' }), makeForm({ dataset: { multi: '' } })]) { submit(f); expect(submit(f).defaultPrevented).toBe(false); }
    const own = makeForm();
    expect(submit(own, { defaultPrevented: true }).defaultPrevented).toBe(true); // was already prevented by the page itself
    expect(own.dataset.sent).toBe(undefined); // and not marked as sent
  });
});
