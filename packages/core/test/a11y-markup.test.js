import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import { a11yIssues } from './support/a11y-lint.js';
import { createPolicy } from '../src/policy/index.js';
import { createSqliteAdapter } from '../src/database/index.js';
import { mountAboutPage } from '../src/about/index.js';
import { setPoweredByLink } from '../src/ui/powered-by.js';

describe('the markup check itself', () => {
  const page = (body, head = '') => `<!doctype html><html lang="ru"><head><title>T</title>${head}</head><body>${body}</body></html>`;
  it('accepts a clean page', () => {
    expect(a11yIssues(page('<h1>A</h1><h2>B</h2><label for="x">Name</label><input id="x"><button>Go</button><img src="a.png" alt="">'))).toEqual([]);
  });
  it('finds the usual problems', () => {
    const bad = '<html><head><title></title><meta name="viewport" content="width=device-width, user-scalable=no"></head><body><h1>A</h1><h3>C</h3><img src="a.png"><input id="y"><input id="y" type="hidden"><button></button><a href="/"><span></span></a></body></html>';
    const found = a11yIssues(bad).join('\n');
    for (const part of ['no lang', 'empty or missing title', 'h1 followed by h3', 'zoom is disabled', 'img: no alt', 'input: no label', 'duplicate "y"', 'button: no accessible name', 'a: no accessible name']) expect(found).toContain(part);
  });
});

describe('the public pages of the core', () => {
  const db = createSqliteAdapter({ file: ':memory:' });
  const app = express();
  app.use((req, res, next) => { req.locale = req.query.lang === 'en' ? 'en' : 'ru'; next(); });
  createPolicy({ db, appName: 'Acme' }).mount(app);
  mountAboutPage(app, { appName: 'Acme', appVersion: '1.0.0', licenseUrl: '/policy/license', security: { contact: ['security@example.org'] } });
  const server = app.listen(0, '127.0.0.1');
  afterAll(() => { server.close(); setPoweredByLink(null); });
  const base = () => `http://127.0.0.1:${server.address().port}`;

  for (const path of ['/policy', '/policy/cookies', '/policy/license', '/policy/accessibility', '/policy/components', '/about']) {
    for (const lang of ['ru', 'en']) {
      it(`${path}?lang=${lang} has no structural accessibility problems`, async () => {
        const res = await fetch(`${base()}${path}?lang=${lang}`);
        expect(res.status).toBe(200);
        expect(a11yIssues(await res.text())).toEqual([]);
      });
    }
  }
});

describe('the account pages', async () => {
  const { pickTexts } = await import('../src/i18n/overrides.js');
  const { ACCOUNT_TEXTS } = await import('../src/accounts/texts.js');
  const pages = await import('../src/accounts/pages.js');
  const render = {
    login: pages.renderLoginPage, 'forced password': pages.renderForcedPasswordPage, forgot: pages.renderForgotPasswordPage,
    reset: pages.renderResetPasswordPage, register: pages.renderRegisterPage, 'register confirm': pages.renderRegisterConfirmPage,
  };
  for (const [name, fn] of Object.entries(render)) {
    for (const locale of ['ru', 'en']) {
      it(`${name} (${locale}) has no structural accessibility problems`, () => {
        expect(a11yIssues(fn({ locale, l: pickTexts(ACCOUNT_TEXTS, undefined, locale), nonce: 'n' }))).toEqual([]);
      });
    }
  }
});
