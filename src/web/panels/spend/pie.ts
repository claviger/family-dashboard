/**
 * The slices for a breakdown's donut (spec §12.12). Pure, so it's unit-tested.
 *
 * - Only rows that spent something (cents > 0) are drawn. A row at zero (it only had spending last
 *   cycle) or below zero (more refunds than spending) can't be a slice; it stays in the table.
 * - Slices are largest first. Equal amounts keep the order they came in (the server's: this cycle,
 *   then last cycle, largest first), so the donut and the table always agree.
 * - The smallest slices whose combined share of the drawn total is at most 5% become one "Other"
 *   slice, unless only one row would go in it: then that row is drawn on its own.
 * - Rows with the same amount are never split between Other and the named slices: if the 5% line
 *   falls between two equal amounts, both stay named.
 * - At most MAX_NAMED slices get a color of their own (the palette has 8 hues, and a 9th would be
 *   indistinguishable). With more, the 7 largest keep theirs and the rest join Other, so Other
 *   always holds at least 2 rows.
 */

export const OTHER_SHARE = 0.05;
export const MAX_NAMED = 8;

export interface PieInput<K = unknown> {
  key: K;
  label: string;
  cents: number;
}

export interface NamedSlice<R extends PieInput> {
  kind: 'named';
  row: R;
  cents: number;
  /** Of the drawn total, 0 to 1. */
  share: number;
  /** The palette slot, 1 to MAX_NAMED, in slice order. */
  slot: number;
}

export interface OtherSlice<R extends PieInput> {
  kind: 'other';
  cents: number;
  share: number;
  /** Largest first. */
  members: R[];
}

export type Slice<R extends PieInput> = NamedSlice<R> | OtherSlice<R>;

export interface Pie<R extends PieInput> {
  /** Largest first, Other (if any) last. Empty when nothing was spent. */
  slices: Slice<R>[];
  /** The sum of the drawn rows: the whole the shares are of. */
  totalCents: number;
  /** Rows that aren't drawn (zero or negative), in the order they came. */
  notDrawn: R[];
}

export function pieSlices<R extends PieInput>(rows: readonly R[]): Pie<R> {
  const drawn = rows.filter((r) => r.cents > 0).sort((a, b) => b.cents - a.cents);
  const notDrawn = rows.filter((r) => r.cents <= 0);
  const totalCents = drawn.reduce((sum, r) => sum + r.cents, 0);
  if (drawn.length === 0) return { slices: [], totalCents: 0, notDrawn };

  // How many of the smallest fit in 5% together (in whole cents: tail <= 5% of total).
  let tail = 0;
  let tailCents = 0;
  for (let i = drawn.length - 1; i > 0; i--) {
    if ((tailCents + drawn[i]!.cents) * 20 > totalCents) break;
    tailCents += drawn[i]!.cents;
    tail++;
  }
  // Don't split a tie across the line: give the tied ones back to the named slices.
  while (tail > 0 && drawn[drawn.length - tail]!.cents === drawn[drawn.length - tail - 1]!.cents) tail--;
  if (tail === 1) tail = 0;

  let named = drawn.length - tail;
  if (named > MAX_NAMED) named = MAX_NAMED - 1;

  const share = (cents: number) => cents / totalCents;
  const slices: Slice<R>[] = drawn.slice(0, named).map((r, i) => ({ kind: 'named', row: r, cents: r.cents, share: share(r.cents), slot: i + 1 }));
  const members = drawn.slice(named);
  if (members.length > 0) {
    const cents = members.reduce((sum, r) => sum + r.cents, 0);
    slices.push({ kind: 'other', cents, share: share(cents), members });
  }
  return { slices, totalCents, notDrawn };
}

/** A share as people read it: "45%", "<1%" for a sliver, never "0%" for something drawn. */
export function shareText(share: number): string {
  if (share > 0 && share < 0.005) return '<1%';
  return `${Math.round(share * 100)}%`;
}

/**
 * The SVG path for one donut segment from `from` to `to` (fractions of the turn, 0 at 12 o'clock,
 * clockwise), centered on (c, c). A whole turn is drawn as two halves, since one arc can't close.
 */
export function arcPath(c: number, outer: number, inner: number, from: number, to: number): string {
  if (to - from >= 1) return `${arcPath(c, outer, inner, 0, 0.5)} ${arcPath(c, outer, inner, 0.5, 1)}`;
  const point = (r: number, t: number) => {
    const a = t * 2 * Math.PI;
    return `${round(c + r * Math.sin(a))} ${round(c - r * Math.cos(a))}`;
  };
  const large = to - from > 0.5 ? 1 : 0;
  return [
    `M ${point(outer, from)}`,
    `A ${outer} ${outer} 0 ${large} 1 ${point(outer, to)}`,
    `L ${point(inner, to)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${point(inner, from)}`,
    'Z',
  ].join(' ');
}

const round = (n: number) => Math.round(n * 100) / 100;
