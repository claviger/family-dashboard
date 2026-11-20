/**
 * Initials on an avatar: a family member's color is free-form (an admin's color picker), so the
 * text color is chosen per color, not per theme. It's whichever of the design system's two
 * `on-fill` values (light paper or dark charcoal) has the higher WCAG 2 contrast with the fill.
 */
export const INK_LIGHT = '#fffcf7';
export const INK_DARK = '#171310';

/** `#rrggbb` or `#rgb` to [r, g, b] in 0..255, or null when it isn't a hex color. */
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG 2 relative luminance of an sRGB color. */
export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`Not a hex color: ${hex}`);
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two hex colors (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The on-fill ink for text on `background`. Ties go to the light ink. Something that isn't a hex
 * color (which the API never sends) gets the light ink, as the avatar always had.
 */
export function avatarInk(background: string): typeof INK_LIGHT | typeof INK_DARK {
  if (!parseHex(background)) return INK_LIGHT;
  return contrastRatio(background, INK_DARK) > contrastRatio(background, INK_LIGHT) ? INK_DARK : INK_LIGHT;
}
