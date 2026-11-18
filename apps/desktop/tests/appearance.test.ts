import { describe, expect, it } from 'vitest';
import { lookFor, PALETTES, seasonFor, type Palette } from '../src/renderer/appearance';
import { AVATAR_COLOURS } from '../src/renderer/avatar';
import { DEFAULT_APPEARANCE, parseAppearance } from '../src/shared/appearance';

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const channel = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (hex: string) => { const [r, g, b] = rgb(hex).map(channel); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const mix = (base: string, over: string, alpha: number) => '#' + rgb(base).map((v, i) => Math.round(v * (1 - alpha) + rgb(over)[i] * alpha).toString(16).padStart(2, '0')).join('');

const looks = Object.entries(PALETTES).flatMap(([look, modes]) => Object.entries(modes).map(([mode, palette]) => [`${look}/${mode}`, palette] as [string, Palette]));
describe.each(looks)('palette %s', (_name, p) => {
  const surfaces = { canvas: p.canvas, sidebar: p.sidebar, panel: p.panel, surface: p.surface, hover: p.hover, selected: p.selected, field: p.field };
  it('keeps body and secondary text at WCAG AA (4.5:1) on every surface', () => {
    for (const [name, bg] of Object.entries(surfaces)) for (const fg of ['text', 'muted'] as const)
      expect(contrast(p[fg], bg), `${fg} on ${name}`).toBeGreaterThanOrEqual(4.5);
  });
  it('keeps text readable where the background art shows through', () => {
    for (const art of p.art) {
      const behind = mix(p.canvas, art, p.artOpacity);
      for (const fg of ['text', 'muted', 'accent'] as const) expect(contrast(p[fg], behind), `${fg} over art ${art}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.focus, behind), `focus ring over art ${art}`).toBeGreaterThanOrEqual(3);
    }
  });
  it('keeps accent, inverse, status and focus colours legible', () => {
    expect(contrast(p.onAccent, p.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.onInverse, p.inverse)).toBeGreaterThanOrEqual(4.5);
    for (const bg of [p.canvas, p.panel, p.surface, p.field]) expect(contrast(p.accent, bg)).toBeGreaterThanOrEqual(4.5);
    for (const tone of [p.good, p.warn, p.bad]) for (const bg of [p.canvas, p.panel, p.surface, p.sidebar]) {
      expect(contrast(tone, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tone, mix(bg, tone, 0.14)), 'badge text on its tinted chip').toBeGreaterThanOrEqual(4.5);
    }
    for (const bg of Object.values(surfaces)) expect(contrast(p.focus, bg)).toBeGreaterThanOrEqual(3);
  });
});

describe('avatars', () => {
  it('keep their white initials at 4.5:1', () => { for (const colour of AVATAR_COLOURS) expect(contrast('#ffffff', colour), colour).toBeGreaterThanOrEqual(4.5); });
});

describe('seasons', () => {
  it('follows the northern calendar by default and flips south of the equator', () => {
    const at = (month: number) => new Date(2026, month, 15);
    expect([0, 3, 6, 9, 11].map(m => seasonFor(at(m), 'America/Chicago'))).toEqual(['winter', 'spring', 'summer', 'autumn', 'winter']);
    expect([0, 3, 6, 9].map(m => seasonFor(at(m), 'Australia/Sydney'))).toEqual(['summer', 'autumn', 'winter', 'spring']);
    expect(seasonFor(at(10))).toBe('autumn');
    expect(lookFor('seasonal', at(1), 'Europe/Paris')).toBe('winter');
    expect(lookFor('summer', at(1), 'Europe/Paris')).toBe('summer');
    expect(lookFor('classic', at(1))).toBe('classic');
  });
  it('accepts only exact preference objects', () => {
    expect(DEFAULT_APPEARANCE).toEqual({ colorMode: 'system', theme: 'seasonal', backgroundArt: true });
    expect(parseAppearance({ colorMode: 'dark', theme: 'winter', backgroundArt: false })).toEqual({ colorMode: 'dark', theme: 'winter', backgroundArt: false });
    for (const bad of [null, [], 'x', { colorMode: 'dark', theme: 'winter' }, { colorMode: 'dim', theme: 'winter', backgroundArt: true }, { colorMode: 'dark', theme: 'halloween', backgroundArt: true }, { colorMode: 'dark', theme: 'winter', backgroundArt: 1 }, { colorMode: 'dark', theme: 'winter', backgroundArt: true, extra: 1 }])
      expect(parseAppearance(bad)).toBeUndefined();
  });
});
