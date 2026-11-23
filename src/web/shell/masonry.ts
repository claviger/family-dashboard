/**
 * Pure helpers for the home page's masonry layout (useMasonry.ts). The grid has small implicit
 * rows and no row gap; each card spans enough rows to cover its own height plus the gap below it.
 */

/** How far past a whole row a height can be before it takes another row (sub-pixel rounding). */
const ROW_EPSILON = 0.01;

/** The number of `rowUnit`-px rows a card of `height` px needs, with `gap` px below it. */
export function rowSpan(height: number, gap: number, rowUnit: number): number {
  if (!(rowUnit > 0) || !Number.isFinite(height) || !Number.isFinite(gap)) return 0;
  return Math.max(1, Math.ceil((height + gap) / rowUnit - ROW_EPSILON));
}

/**
 * The number of columns in a computed `grid-template-columns` (a list of px sizes). Tracks that
 * auto-fit collapsed to 0px aren't counted, since nothing can sit in them.
 */
export function trackCount(computedColumns: string): number {
  return computedColumns
    .trim()
    .split(/\s+/)
    .filter((track) => /^[\d.]+px$/.test(track) && Number.parseFloat(track) > 0).length;
}
