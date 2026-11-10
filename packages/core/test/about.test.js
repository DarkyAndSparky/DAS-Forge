import { describe, it, expect, afterEach } from 'vitest';
import { mountAboutPage } from '../src/about/index.js';
import { setPoweredByLink, poweredByHtml } from '../src/ui/powered-by.js';

afterEach(() => setPoweredByLink(null));

function render(opts, req = {}) {
  const routes = {};
  mountAboutPage({ get: (p, h) => { routes[p] = h; } }, opts);
  let html = '';
  routes[opts.path ?? '/about']({ locale: 'ru', ...req }, { type() { return this; }, send(b) { html = b; }, locals: {} });
  return html;
}

describe('public About page', () => {
  it('shows the versions, the licence holder, the author and the sources, in the reader\'s language', () => {
    const html = render({ appName: 'Workshop', appVersion: '1.2.3', coreVersion: '0.1.99', copyright: 'Acme', author: { name: 'Ann', url: 'https://example.org/ann' }, licenseUrl: '/policy/license' });
    expect(html).toContain('DAS-Forge 0.1.99');
    expect(html).toContain('Workshop');
    expect(html).toContain('1.2.3');
    expect(html).toContain('© Acme');
    expect(html).toContain('href="/policy/license"');
    expect(html).toContain('href="https://example.org/ann"');
    expect(html).toContain('github.com/DarkyAndSparky/DAS-Forge');
    expect(html).toContain('О платформе');
    expect(render({}, { locale: 'en' })).toContain('About the platform');
  });

  it('shows no runtime details', () => {
    const html = render({ appName: 'W' });
    expect(html).not.toContain(process.version);
    expect(html).not.toMatch(/node_modules|win32|linux/);
  });

  it('escapes names and descriptions; only https links and own-site or https logos are used', () => {
    const html = render({ appName: '<img src=x>', apps: [
      { name: '<b>A</b>', version: '1', logoUrl: '/brand/a.svg', repoUrl: 'https://example.org/a', description: '<script>1</script>' },
      { name: 'B', logoUrl: 'javascript:alert(1)', repoUrl: 'javascript:alert(1)' },
      { name: 'C', logoUrl: '//evil.example/x.png', repoUrl: 'http://example.org/c' },
    ], author: { name: 'x', url: 'javascript:alert(1)' }, repositories: [{ name: 'bad', url: 'http://example.org' }, { name: 'ok', url: 'https://example.org/r' }] });
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toContain('<b>A</b>');
    expect(html).not.toContain('<script>1');
    expect(html).toContain('src="/brand/a.svg"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('href="http://');
    expect(html).toContain('href="https://example.org/r"');
  });

  it('the "Powered by" line leads to the page and carries the core version, and goes back to the repository link otherwise', () => {
    expect(poweredByHtml('ru')).toContain('target="_blank"');
    render({ coreVersion: '0.1.99' });
    const html = poweredByHtml('ru');
    expect(html).toContain('href="/about"');
    expect(html).toContain('DAS-Forge 0.1.99');
    expect(html).not.toContain('target="_blank"');
  });
});
