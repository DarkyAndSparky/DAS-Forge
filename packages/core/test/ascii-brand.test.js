import { describe, it, expect } from 'vitest';
import { DAS_FORGE_WORDMARK, DAS_FORGE_LOGO, renderBanner } from '../src/ui/ascii-brand.js';
import { ui } from '../src/index.js';

describe('ASCII brand', () => {
  it('the lettering and the logo are plain text lines that fit a 120-column console', () => {
    for (const art of [DAS_FORGE_WORDMARK, DAS_FORGE_LOGO]) {
      expect(art.length).toBeGreaterThan(5);
      for (const l of art) { expect(l).toBe(l.trimEnd()); expect([...l].length <= 100).toBe(true); }
      expect(art.some((l) => l.length > 0 && !l.startsWith(' '))).toBe(true); // no common indent left
    }
    expect(Object.isFrozen(DAS_FORGE_WORDMARK)).toBe(true);
  });
  it('renderBanner: logo, "=", lettering, "=", rows, "=", an empty line around every block, all indented', () => {
    const t = renderBanner(['one', 'two']).split('\n');
    const isBar = (l) => /^ {2}=+$/.test(l);
    const bars = t.map((l, i) => (isBar(l) ? i : -1)).filter((i) => i >= 0);
    expect(bars).toHaveLength(3);
    expect(t.at(-1)).toBe(t[bars[0]]);
    expect(t[0]).toBe(''); // nothing above the logo, an empty line first
    expect(t[bars[0] - 1]).toBe('');
    expect(t[bars[0] + 1]).toBe('');
    expect(t[bars[1] - 1]).toBe('');
    expect(t[bars[1] + 1]).toBe('');
    expect(t.slice(bars[1] + 2, -2)).toEqual(['  one', '  two']);
    const logoPart = t.slice(0, bars[0]).join('\n');
    const wordPart = t.slice(bars[0], bars[1]).join('\n');
    for (const l of DAS_FORGE_LOGO.filter((x) => x.trim())) expect(logoPart).toContain(l.trim());
    for (const l of DAS_FORGE_WORDMARK) expect(wordPart).toContain(l);
    expect(t.every((l) => l === '' || l.startsWith('  '))).toBe(true);
  });
  it('without the logo and the lettering only the rows and one closing line remain', () => {
    expect(renderBanner(['x'], { wordmark: false, logo: false })).toBe('\n  x\n\n  =');
  });
  it('is exported with the ui module', () => {
    expect(typeof ui.renderBanner).toBe('function');
    expect(ui.DAS_FORGE_LOGO.length).toBe(DAS_FORGE_LOGO.length);
  });
});
