import { describe, expect, it } from 'vitest';
import { chartGeometry, FLOW_MARKER_HALF, FLOW_OFFSET, FLOW_OPACITY_DENSE_MIN, FLOW_OPACITY_MIN, flowFloor, flowMarks, flowOpacity, nearestIndex, niceTicks } from './chart.js';

const box = { width: 600, height: 200, left: 64, right: 8, top: 12, bottom: 28 };

describe('niceTicks', () => {
  it('spans the values with round steps', () => {
    expect(niceTicks(0, 100_000_00)).toEqual([0, 25_000_00, 50_000_00, 75_000_00, 100_000_00]);
    expect(niceTicks(6_120_00, 6_840_00)).toEqual([6_000_00, 6_200_00, 6_400_00, 6_600_00, 6_800_00, 7_000_00]);
    expect(niceTicks(5_00, 5_00)).toEqual([4_00, 5_00, 6_00]);
  });

  it('starts at or below the minimum and ends at or above the maximum', () => {
    for (const [lo, hi] of [[1_23, 9_87_65], [-5_00_00, 12_34_00], [99_99, 1_00_01], [0, 1]] as const) {
      const t = niceTicks(lo, hi);
      expect(t[0]!, `${lo}`).toBeLessThanOrEqual(lo);
      expect(t.at(-1)!, `${hi}`).toBeGreaterThanOrEqual(hi);
      expect(t.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('chartGeometry', () => {
  const points = [{ date: '2026-11-13', cents: 6_000_00 }, { date: '2026-11-14', cents: 6_400_00 }, { date: '2026-11-15', cents: 6_800_00 }];

  it("maps the six months across the width and the ticks up the height, with the line only where there's data", () => {
    const g = chartGeometry(points, '2026-05-15', '2026-11-15', box)!;
    expect(g.x('2026-05-15')).toBe(64);
    expect(g.x('2026-11-15')).toBe(592);
    expect(g.yTicks.map((t) => t.cents)).toEqual([6_000_00, 6_200_00, 6_400_00, 6_600_00, 6_800_00]);
    expect(g.y(6_000_00)).toBe(172);
    expect(g.y(6_800_00)).toBe(12);
    expect(g.path.startsWith(`M${g.x('2026-11-13').toFixed(1)},172.0`)).toBe(true);
    expect(g.path.split('L')).toHaveLength(3);
    // A tick at each month's first day in the range.
    expect(g.xTicks.map((t) => t.month)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    expect(g.last).toEqual({ x: 592, y: 12, date: '2026-11-15', cents: 6_800_00 });
  });

  it('puts a tick on the first day when the range starts on the 1st of a month', () => {
    const g = chartGeometry([{ date: '2026-12-01', cents: 1_00 }], '2026-06-01', '2026-12-01', box)!;
    expect(g.xTicks.map((t) => t.month)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12']);
    expect(g.xTicks[0]!.x).toBe(64);
    expect(g.xTicks.at(-1)!.x).toBe(592);
  });

  it('draws one point as a dot, and nothing without points', () => {
    expect(chartGeometry([points[0]!], '2026-05-15', '2026-11-15', box)!.path.includes('L')).toBe(false);
    expect(chartGeometry([], '2026-05-15', '2026-11-15', box)).toBeNull();
  });

  it('finds the point nearest a pointer position', () => {
    const g = chartGeometry(points, '2026-05-15', '2026-11-15', box)!;
    expect(nearestIndex(g, 0)).toBe(0);
    expect(nearestIndex(g, g.x('2026-11-14') + 1)).toBe(1);
    expect(nearestIndex(g, 10_000)).toBe(2);
  });
});

describe('flowOpacity', () => {
  it('runs straight from the floor for a tiny flow to full for the largest', () => {
    expect(flowOpacity(3_000_00, 3_000_00)).toBe(1);
    expect(flowOpacity(0, 3_000_00)).toBe(FLOW_OPACITY_MIN);
    expect(flowOpacity(20_00, 3_000_00)).toBeLessThan(0.21);
    expect(flowOpacity(1_500_00, 3_000_00)).toBeCloseTo(FLOW_OPACITY_MIN + (1 - FLOW_OPACITY_MIN) / 2);
    expect(flowOpacity(1_500_00, 3_000_00, 0.1)).toBeCloseTo(0.55);
    expect(flowOpacity(1, 0)).toBe(FLOW_OPACITY_MIN);
  });

  it('only rises with the amount', () => {
    let prev = 0;
    for (const c of [1, 10_00, 100_00, 1_000_00, 2_999_99, 3_000_00]) {
      const o = flowOpacity(c, 3_000_00);
      expect(o).toBeGreaterThan(prev);
      prev = o;
    }
  });

  it('lowers the floor where the days are packed tight', () => {
    expect(flowFloor(10)).toBe(FLOW_OPACITY_MIN);
    expect(flowFloor(3)).toBe(FLOW_OPACITY_MIN);
    expect(flowFloor(2)).toBeCloseTo((FLOW_OPACITY_MIN + FLOW_OPACITY_DENSE_MIN) / 2);
    expect(flowFloor(1)).toBe(FLOW_OPACITY_DENSE_MIN);
    expect(flowFloor(0.5)).toBe(FLOW_OPACITY_DENSE_MIN);
  });
});

describe('flowMarks', () => {
  const points = [{ date: '2026-11-13', cents: 6_000_00 }, { date: '2026-11-14', cents: 6_400_00 }, { date: '2026-11-15', cents: 6_800_00 }];
  const g = chartGeometry(points, '2026-05-15', '2026-11-15', box)!;

  it('draws a full-height line per flow, a ▲ above a deposit and a ▼ above a withdrawal', () => {
    const marks = flowMarks(g, [
      { date: '2026-11-13', depositCents: 3_000_00, withdrawalCents: 0 },
      { date: '2026-11-15', depositCents: 0, withdrawalCents: 30_00 },
    ], box);
    const dep = marks.find((m) => m.kind === 'deposit')!;
    const wd = marks.find((m) => m.kind === 'withdrawal')!;
    expect([dep.x, dep.y1, dep.y2, dep.opacity]).toEqual([g.x('2026-11-13'), 12, 172, 1]);
    expect(wd.x).toBe(g.x('2026-11-15'));
    // 528px over 184 days is under 3px a day, so the floor is a little under FLOW_OPACITY_MIN.
    expect(wd.opacity).toBeCloseTo(flowFloor(528 / 184) + (1 - flowFloor(528 / 184)) * (30_00 / 3_000_00));
    // ▲: the base at the plot's top less 2, the tip 6 above, pointing up.
    const x = dep.x;
    expect(dep.marker).toBe(`M${(x - FLOW_MARKER_HALF).toFixed(1)},10.0L${(x + FLOW_MARKER_HALF).toFixed(1)},10.0L${x.toFixed(1)},4.0Z`);
    // ▼: flat at the top, the tip pointing down at the plot.
    const w = wd.x;
    expect(wd.marker).toBe(`M${(w - FLOW_MARKER_HALF).toFixed(1)},4.0L${(w + FLOW_MARKER_HALF).toFixed(1)},4.0L${w.toFixed(1)},10.0Z`);
    // Faint first, so a strong line paints over it.
    expect(marks.map((m) => m.kind)).toEqual(['withdrawal', 'deposit']);
  });

  it('puts a day with both side by side, deposit left', () => {
    const marks = flowMarks(g, [{ date: '2026-11-14', depositCents: 10_00, withdrawalCents: 20_00 }], box);
    const day = g.x('2026-11-14');
    expect(marks.find((m) => m.kind === 'deposit')!.x).toBe(day - FLOW_OFFSET);
    expect(marks.find((m) => m.kind === 'withdrawal')!.x).toBe(day + FLOW_OFFSET);
    expect(marks.find((m) => m.kind === 'deposit')!.marker.startsWith(`M${(day - 2 * FLOW_MARKER_HALF).toFixed(1)},`)).toBe(true);
  });

  it('scales against the largest flow drawn, and leaves out days outside the line', () => {
    const marks = flowMarks(g, [
      { date: '2026-11-01', depositCents: 1_000_000_00, withdrawalCents: 0 },
      { date: '2026-11-14', depositCents: 50_00, withdrawalCents: 0 },
    ], box);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.opacity).toBe(1);
  });
});
