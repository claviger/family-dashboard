import { describe, expect, it } from 'vitest';
import { arcPath, MAX_NAMED, pieSlices, shareText, type PieInput } from './pie.js';

const row = (key: string, cents: number): PieInput<string> => ({ key, label: key, cents });
const shape = (rows: PieInput<string>[]) =>
  pieSlices(rows).slices.map((s) => (s.kind === 'named' ? `${s.row.key}:${s.cents}` : `Other[${s.members.map((m) => m.key).join(',')}]:${s.cents}`));

describe('pieSlices', () => {
  it('is empty with no rows, and with nothing spent', () => {
    expect(pieSlices([])).toEqual({ slices: [], totalCents: 0, notDrawn: [] });
    const p = pieSlices([row('a', 0), row('b', -500)]);
    expect(p.slices).toEqual([]);
    expect(p.totalCents).toBe(0);
    expect(p.notDrawn.map((r) => r.key)).toEqual(['a', 'b']);
  });

  it('draws one row as the whole ring', () => {
    const p = pieSlices([row('a', 1234)]);
    expect(p.slices).toEqual([{ kind: 'named', row: row('a', 1234), cents: 1234, share: 1, slot: 1 }]);
  });

  it('sorts largest first and numbers the palette slots in that order', () => {
    const p = pieSlices([row('small', 300), row('big', 600), row('mid', 400)]);
    expect(p.slices.map((s) => (s.kind === 'named' ? [s.row.key, s.slot] : null))).toEqual([['big', 1], ['mid', 2], ['small', 3]]);
    expect(p.totalCents).toBe(1300);
  });

  it('folds the smallest into Other when together they are at most 5%', () => {
    // 900 + 60 + 25 + 15 = 1000: 25 + 15 = 4% fits, adding 60 makes 10%.
    expect(shape([row('a', 900), row('b', 60), row('c', 25), row('d', 15)])).toEqual(['a:900', 'b:60', 'Other[c,d]:40']);
  });

  it('counts exactly 5% as fitting', () => {
    // 950 + 30 + 20 = 1000; 30 + 20 = 50 = 5%.
    expect(shape([row('a', 950), row('b', 30), row('c', 20)])).toEqual(['a:950', 'Other[b,c]:50']);
    expect(shape([row('a', 949), row('b', 31), row('c', 20)])).toEqual(['a:949', 'b:31', 'c:20']);
  });

  it('shows a lone small slice on its own instead of an Other of one', () => {
    expect(shape([row('a', 990), row('b', 10)])).toEqual(['a:990', 'b:10']);
    // Only the smallest fits in 5%; the next would take it past.
    expect(shape([row('a', 900), row('b', 70), row('c', 30)])).toEqual(['a:900', 'b:70', 'c:30']);
  });

  it('never folds everything: the largest always stays named', () => {
    // All tiny and equal: none fit together, and ties aren't split.
    const even = Array.from({ length: 30 }, (_, i) => row(`r${i}`, 100));
    const p = pieSlices(even);
    expect(p.slices.filter((s) => s.kind === 'named')).toHaveLength(MAX_NAMED - 1);
    expect(p.slices.at(-1)!.kind).toBe('other');
  });

  it("doesn't split equal amounts between Other and the named slices", () => {
    // 1000 + 30 + 30 + 30: the 5% line (54.5) falls between the 30s, so none go.
    expect(shape([row('a', 1000), row('b', 30), row('c', 30), row('d', 30)])).toEqual(['a:1000', 'b:30', 'c:30', 'd:30']);
    // Equal amounts that all fit go together.
    expect(shape([row('a', 1000), row('b', 20), row('c', 20)])).toEqual(['a:1000', 'Other[b,c]:40']);
  });

  it('keeps the order rows came in for equal amounts', () => {
    expect(shape([row('x', 500), row('y', 500), row('z', 500)])).toEqual(['x:500', 'y:500', 'z:500']);
  });

  it("leaves zero and negative rows (refunds) out of the ring and its total, but keeps them", () => {
    const p = pieSlices([row('a', 800), row('refunds', -300), row('lastCycleOnly', 0), row('b', 200)]);
    expect(shape([row('a', 800), row('refunds', -300), row('lastCycleOnly', 0), row('b', 200)])).toEqual(['a:800', 'b:200']);
    expect(p.totalCents).toBe(1000);
    expect(p.slices.map((s) => s.share)).toEqual([0.8, 0.2]);
    expect(p.notDrawn.map((r) => r.key)).toEqual(['refunds', 'lastCycleOnly']);
  });

  it('gives at most 8 slices a color; past that the rest join Other, never an Other of one', () => {
    const nine = Array.from({ length: 9 }, (_, i) => row(`r${i}`, 1000 - i));
    const p = pieSlices(nine);
    expect(p.slices.filter((s) => s.kind === 'named').map((s) => (s.kind === 'named' ? s.slot : 0))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const other = p.slices.at(-1)!;
    expect(other.kind === 'other' && other.members.map((m) => m.key)).toEqual(['r7', 'r8']);
    // Exactly 8 fit.
    expect(pieSlices(nine.slice(0, 8)).slices.every((s) => s.kind === 'named')).toBe(true);
  });

  it('shares add up to the whole', () => {
    const p = pieSlices([row('a', 333), row('b', 333), row('c', 334)]);
    expect(p.slices.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 10);
  });
});

describe('shareText', () => {
  it('rounds to whole percents and never says 0% for a drawn sliver', () => {
    expect(shareText(0.456)).toBe('46%');
    expect(shareText(1)).toBe('100%');
    expect(shareText(0.004)).toBe('<1%');
    expect(shareText(0)).toBe('0%');
  });
});

describe('arcPath', () => {
  it('draws a quarter from 12 to 3 o\'clock', () => {
    expect(arcPath(50, 40, 20, 0, 0.25)).toBe('M 50 10 A 40 40 0 0 1 90 50 L 70 50 A 20 20 0 0 0 50 30 Z');
  });

  it('uses the large-arc flag past half a turn, and two halves for a whole one', () => {
    expect(arcPath(50, 40, 20, 0, 0.75)).toContain('A 40 40 0 1 1');
    expect(arcPath(50, 40, 20, 0, 1).match(/M /g)).toHaveLength(2);
  });
});
