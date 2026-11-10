import { describe, it, expect } from 'vitest';
import { sanitizeSvg } from '../src/files/svg-sanitize.js';

const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10">${inner}</svg>`;

describe('SVG sanitizer: nothing is fetched from outside (audit B11)', () => {
  it('external href / xlink:href never survive (DOMPurify\'s SVG profile drops <use> altogether)', () => {
    const out = sanitizeSvg(wrap('<defs><path id="a" d="M0 0h5"/></defs><use href="https://evil.example/x.svg#a"/><use xlink:href="//evil.example/y.svg#a"/><use href="#a"/><image href="http://tracker.example/p.png" width="1" height="1"/>'));
    expect(out).not.toMatch(/evil\.example|tracker\.example/);
    expect(out).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(out).toMatch(/<path/); // ordinary shapes are untouched
  });

  it('@import and external url() in <style> and in style="" are removed', () => {
    const out = sanitizeSvg(wrap('<style>@import url(https://evil.example/a.css); rect{fill:red}</style><rect width="1" height="1" style="fill:url(https://evil.example/f)"/>'));
    expect(out).not.toMatch(/evil\.example|@import/);
  });

  it('url(#gradient) keeps working', () => {
    const out = sanitizeSvg(wrap('<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="5" height="5" style="fill:url(#g)"/>'));
    expect(out).toMatch(/url\(#g\)/);
  });

  it('entity declarations are refused outright; a leading BOM is tolerated', () => {
    expect(() => sanitizeSvg('<!DOCTYPE svg [<!ENTITY x "boom">]>' + wrap('<text>&x;</text>'))).toThrow(/entity/i);
    expect(sanitizeSvg('﻿' + wrap('<rect width="1" height="1"/>'))).toMatch(/<svg/);
  });

  it('scripts and handlers are still removed', () => {
    const out = sanitizeSvg(wrap('<script>alert(1)</script><rect width="1" height="1" onclick="alert(2)"/>'));
    expect(out).not.toMatch(/script|onclick|alert/);
  });
});
