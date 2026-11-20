import { daysBetween } from '../../../shared/dates.js';

/**
 * The six-month graph's geometry (the Savings spec, "Line graph"), apart from React so it's
 * unit-tested. Coordinates are in the SVG's viewBox; the SVG scales to its container's width.
 */

export interface ChartBox {
  width: number;
  height: number;
  /** Room for the y-axis labels. */
  left: number;
  right: number;
  top: number;
  /** Room for the month labels. */
  bottom: number;
}

export interface ChartPoint {
  x: number;
  y: number;
  date: string;
  cents: number;
}

export interface ChartGeometry {
  /** The line's path, or a single move for one point (drawn as the dot alone). */
  path: string;
  x: (date: string) => number;
  y: (cents: number) => number;
  yTicks: { cents: number; y: number }[];
  xTicks: { month: string; x: number }[];
  points: ChartPoint[];
  last: ChartPoint;
}

/**
 * Round ticks covering `min`..`max` in about `count` steps of 1, 2, 2.5 or 5 times a power of ten
 * (in cents, never under a cent): the first at or below `min`, the last at or above `max`.
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    const pad = Math.max(1_00, Math.abs(min) * 0.2);
    return niceTicks(min - pad, max + pad, 2);
  }
  const raw = (max - min) / count;
  const power = Math.max(1, 10 ** Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw)!;
  const first = Math.floor(min / step);
  const ticks: number[] = [];
  for (let i = first; ; i++) {
    const v = Math.round(i * step);
    ticks.push(v);
    if (v >= max) break;
  }
  return ticks;
}

/** Null without points. `rangeStart`..`today` spans the width, so a graph still filling in starts part way across. */
export function chartGeometry(series: readonly { date: string; cents: number }[], rangeStart: string, today: string, box: ChartBox): ChartGeometry | null {
  if (series.length === 0) return null;
  const span = Math.max(1, daysBetween(rangeStart, today));
  const plotW = box.width - box.left - box.right;
  const plotH = box.height - box.top - box.bottom;
  const values = series.map((p) => p.cents);
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const lo = ticks[0]!;
  const hi = ticks.at(-1)!;
  const x = (date: string) => box.left + (daysBetween(rangeStart, date) / span) * plotW;
  const y = (cents: number) => box.top + (1 - (cents - lo) / (hi - lo)) * plotH;
  const points = series.map((p) => ({ x: x(p.date), y: y(p.cents), date: p.date, cents: p.cents }));
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
  const xTicks: ChartGeometry['xTicks'] = [];
  for (let m = new Date(`${rangeStart.slice(0, 7)}-01T00:00:00Z`); ; m.setUTCMonth(m.getUTCMonth() + 1)) {
    const first = m.toISOString().slice(0, 10);
    if (first > today) break;
    if (first >= rangeStart) xTicks.push({ month: first.slice(0, 7), x: x(first) });
  }
  return { path, x, y, yTicks: ticks.map((cents) => ({ cents, y: y(cents) })), xTicks, points, last: points.at(-1)! };
}

/** The point whose x is nearest `px` (viewBox units), for the hover crosshair. */
export function nearestIndex(g: ChartGeometry, px: number): number {
  let best = 0;
  for (let i = 1; i < g.points.length; i++) if (Math.abs(g.points[i]!.x - px) < Math.abs(g.points[best]!.x - px)) best = i;
  return best;
}

/** The flow lines' faintest and strongest opacity: small bills stay faint, paychecks and big transfers stand out. */
export const FLOW_OPACITY_MIN = 0.2;
export const FLOW_OPACITY_MAX = 1;
/** The faintest a line goes where the days are packed tight (a phone's six months), so small bills don't merge into a band. */
export const FLOW_OPACITY_DENSE_MIN = 0.08;
/** How far apart a day's deposit and withdrawal lines sit, each side of the day (viewBox units). */
export const FLOW_OFFSET = 1.5;
/** The marker's half-width and height. */
export const FLOW_MARKER_HALF = 3.5;
export const FLOW_MARKER_HEIGHT = 6;

/**
 * The faintest opacity for days `pxPerDay` apart: FLOW_OPACITY_MIN from 3px a day (the card, a wide
 * six months), down to FLOW_OPACITY_DENSE_MIN at 1px a day, where every faint line overlaps its
 * neighbors and they'd read as a solid wash.
 */
export function flowFloor(pxPerDay: number): number {
  const t = Math.min(1, Math.max(0, (pxPerDay - 1) / 2));
  return FLOW_OPACITY_DENSE_MIN + (FLOW_OPACITY_MIN - FLOW_OPACITY_DENSE_MIN) * t;
}

/**
 * A flow line's opacity: its share of the window's largest single deposit or withdrawal, straight
 * (linear) from `floor` to FLOW_OPACITY_MAX, so a paycheck or a big transfer is solid and a $20
 * bill next to a $3,000 paycheck stays near the floor. (The square root made dozens of bills
 * strong enough to read as a barcode.)
 */
export function flowOpacity(cents: number, maxCents: number, floor = FLOW_OPACITY_MIN): number {
  if (maxCents <= 0 || cents <= 0) return floor;
  const share = Math.min(1, cents / maxCents);
  return floor + (FLOW_OPACITY_MAX - floor) * share;
}

export interface FlowMark {
  date: string;
  kind: 'deposit' | 'withdrawal';
  cents: number;
  x: number;
  /** The line, full plot height. */
  y1: number;
  y2: number;
  /** The line's and its marker's opacity. */
  opacity: number;
  /** The marker above the plot: ▲ for a deposit, ▼ for a withdrawal. */
  marker: string;
}

/**
 * One full-height line per day and kind of flow (the Savings spec, "Line graph"), a ▲ or ▼ marker
 * just above the plot. A day with both draws both, FLOW_OFFSET each side of the day (deposit
 * left), the markers side by side. Days outside the geometry's points aren't drawn.
 */
export function flowMarks(g: ChartGeometry, flows: readonly { date: string; depositCents: number; withdrawalCents: number }[], box: ChartBox): FlowMark[] {
  const first = g.points[0]!.date;
  const shown = flows.filter((f) => f.date >= first && f.date <= g.last.date);
  const maxCents = Math.max(0, ...shown.flatMap((f) => [f.depositCents, f.withdrawalCents]));
  const floor = flowFloor(g.x('2000-01-02') - g.x('2000-01-01'));
  const y1 = box.top;
  const y2 = box.height - box.bottom;
  const out: FlowMark[] = [];
  for (const f of shown) {
    const both = f.depositCents > 0 && f.withdrawalCents > 0;
    const day = g.x(f.date);
    for (const kind of ['deposit', 'withdrawal'] as const) {
      const cents = kind === 'deposit' ? f.depositCents : f.withdrawalCents;
      if (cents <= 0) continue;
      const x = both ? day + (kind === 'deposit' ? -FLOW_OFFSET : FLOW_OFFSET) : day;
      const mx = both ? day + (kind === 'deposit' ? -FLOW_MARKER_HALF : FLOW_MARKER_HALF) : day;
      const base = y1 - 2;
      const tip = base - FLOW_MARKER_HEIGHT;
      const r = (n: number) => n.toFixed(1);
      // ▲ points up from its base; ▼ hangs from the top down to the plot.
      const marker = kind === 'deposit'
        ? `M${r(mx - FLOW_MARKER_HALF)},${r(base)}L${r(mx + FLOW_MARKER_HALF)},${r(base)}L${r(mx)},${r(tip)}Z`
        : `M${r(mx - FLOW_MARKER_HALF)},${r(tip)}L${r(mx + FLOW_MARKER_HALF)},${r(tip)}L${r(mx)},${r(base)}Z`;
      out.push({ date: f.date, kind, cents, x, y1, y2, opacity: flowOpacity(cents, maxCents, floor), marker });
    }
  }
  // The faint ones first, so a strong line is never painted under a faint one.
  return out.sort((a, b) => a.opacity - b.opacity);
}
