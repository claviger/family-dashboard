import { describe, expect, it } from 'vitest';
import { avatarInk, contrastRatio, INK_DARK, INK_LIGHT, relativeLuminance } from './avatarInk.js';

describe('relativeLuminance', () => {
  it('matches the WCAG endpoints', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
    expect(relativeLuminance('#fff')).toBeCloseTo(1, 10);
  });

  it('throws on something that is not a hex color', () => {
    expect(() => relativeLuminance('red')).toThrow();
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white, either way round', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
  });

  it('is 1 for a color on itself', () => {
    expect(contrastRatio('#b04327', '#b04327')).toBe(1);
  });
});

describe('avatarInk', () => {
  it('puts light ink on dark and saturated fills', () => {
    expect(avatarInk('#000000')).toBe(INK_LIGHT);
    expect(avatarInk('#b04327')).toBe(INK_LIGHT); // person-1, light theme
    expect(avatarInk('#2a5f8f')).toBe(INK_LIGHT); // person-2, light theme
    expect(avatarInk('#1D9E75')).toBe(INK_DARK); // the admin form's default green is light enough for dark ink
  });

  it('puts dark ink on light fills', () => {
    expect(avatarInk('#ffffff')).toBe(INK_DARK);
    expect(avatarInk('#ffff00')).toBe(INK_DARK);
    expect(avatarInk('#f0937a')).toBe(INK_DARK); // person-1, dark theme
    expect(avatarInk('#8fbfe8')).toBe(INK_DARK); // person-2, dark theme
  });

  it('always picks the ink with the higher contrast', () => {
    for (const fill of ['#378ADD', '#808080', '#e24b4a', '#7b3f98', '#e8b865', '#123456', '#abcdef', '#777']) {
      const ink = avatarInk(fill);
      const other = ink === INK_LIGHT ? INK_DARK : INK_LIGHT;
      expect(contrastRatio(fill, ink)).toBeGreaterThanOrEqual(contrastRatio(fill, other));
    }
  });

  it('accepts upper case and short hex, and falls back to light ink for anything else', () => {
    expect(avatarInk('#FFF')).toBe(INK_DARK);
    expect(avatarInk('not a color')).toBe(INK_LIGHT);
    expect(avatarInk('')).toBe(INK_LIGHT);
  });
});
