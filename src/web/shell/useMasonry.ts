import { useLayoutEffect, type RefObject } from 'react';
import { rowSpan, trackCount } from './masonry.js';

/**
 * Masonry for a card grid: each card spans as many of the grid's small implicit rows as its own
 * height plus the gap needs, so a card starts right below the one above it in its column instead
 * of below the tallest card in the row. DOM order, and so focus and reading order, don't change;
 * auto-placement stays sparse, so a card never moves ahead of an earlier one.
 *
 * The `masonry` class (the small rows, no row gap) goes on only once every card has its span, and
 * comes off on a single column, so without JS, before the first measurement, and on phones the grid
 * is the plain one. The spans are written through the CSSOM (`el.style`), which the CSP allows.
 *
 * The grid's className must not change between renders, since this adds the class directly.
 *
 * @param resetKey changes when the set of cards changes, so the new children are observed.
 */
export function useMasonry(ref: RefObject<HTMLElement | null>, resetKey: string) {
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid || typeof ResizeObserver === 'undefined') return;
    const cards = [...grid.children].filter((el): el is HTMLElement => el instanceof HTMLElement);

    const off = () => {
      grid.classList.remove('masonry');
      for (const card of cards) card.style.removeProperty('grid-row-end');
    };

    const apply = () => {
      const style = getComputedStyle(grid);
      const unit = Number.parseFloat(style.getPropertyValue('--masonry-row'));
      const gap = Number.parseFloat(style.columnGap) || 0;
      if (trackCount(style.gridTemplateColumns) < 2 || !(unit > 0)) {
        off();
        return;
      }
      // Read every height before writing any span, so the writes don't force a layout each.
      // The cards align to the start of their area, so a card's height is its content's and a
      // span can't change it: no feedback loop.
      const spans = cards.map((card) => rowSpan(card.getBoundingClientRect().height, gap, unit));
      cards.forEach((card, i) => {
        const value = `span ${spans[i]}`;
        if (card.style.gridRowEnd !== value) card.style.gridRowEnd = value;
      });
      grid.classList.add('masonry');
    };

    let frame = 0;
    const schedule = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          apply();
        });
      }
    };

    // The first pass runs before paint; later ones (data loading, the window resizing) batch into
    // one frame. The grid itself is observed for width changes that change the column count.
    apply();
    const observer = new ResizeObserver(schedule);
    observer.observe(grid);
    for (const card of cards) observer.observe(card);

    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      off();
    };
  }, [ref, resetKey]);
}
