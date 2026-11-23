import { describe, expect, it } from 'vitest';
import { rowSpan, trackCount } from './masonry.js';

describe('rowSpan', () => {
  it('covers the card and the gap below it in whole rows', () => {
    expect(rowSpan(100, 24, 2)).toBe(62);
    expect(rowSpan(101, 24, 2)).toBe(63);
    expect(rowSpan(100.4, 24, 2)).toBe(63);
  });

  it('never leaves more than one row unit of extra space', () => {
    for (const h of [0, 1, 37.5, 199.99, 812.25]) {
      const span = rowSpan(h, 24, 2);
      expect(span * 2).toBeGreaterThanOrEqual(h + 24);
      expect(span * 2 - (h + 24)).toBeLessThan(2);
    }
  });

  it('ignores sub-pixel noise just over a whole row', () => {
    expect(rowSpan(100.004, 24, 2)).toBe(62);
  });

  it('spans at least one row, and none for a bad row unit', () => {
    expect(rowSpan(0, 0, 2)).toBe(1);
    expect(rowSpan(100, 24, 0)).toBe(0);
    expect(rowSpan(Number.NaN, 24, 2)).toBe(0);
  });
});

describe('trackCount', () => {
  it('counts the computed column tracks', () => {
    expect(trackCount('316px 316px 316px 316px')).toBe(4);
    expect(trackCount('356.5px 356.5px')).toBe(2);
    expect(trackCount('343px')).toBe(1);
  });

  it("doesn't count the tracks auto-fit collapsed to zero", () => {
    expect(trackCount('500px 0px 0px')).toBe(1);
  });

  it('is zero when there is no grid', () => {
    expect(trackCount('none')).toBe(0);
    expect(trackCount('')).toBe(0);
  });
});
