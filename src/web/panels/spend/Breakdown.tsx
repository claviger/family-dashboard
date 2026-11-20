import { useState } from 'react';
import { money, type PeriodNames } from './format.js';
import { arcPath, pieSlices, shareText, type Slice } from './pie.js';

export interface BreakdownRow<K> {
  key: K;
  label: string;
  cents: number;
  previousCents: number;
}

/**
 * Spending by category or by person (spec §12.12): a donut, and one table that is both its legend
 * and its data. Screen readers get the table (names, amounts, shares, last cycle) and a one-line
 * summary as the chart's name; the slices themselves aren't read. Each name is a toggle button
 * that filters the transactions below, and so is its slice (for a pointer; the button is the
 * keyboard's way). The pressed one is the filter.
 *
 * Slices come from pieSlices: largest first, the smallest 5% folded into Other. Other isn't a
 * filter (there's no filter for a group), so its slice does nothing when pressed; its members are
 * always listed under it in the table, each with its own button. Rows that spent nothing or got
 * more back than they spent aren't drawn, and are listed last.
 */
export function Breakdown<K extends string | number>(props: {
  id: string;
  title: string;
  /** The cycle on screen and the one before it: "this cycle", or a past cycle's dates. */
  period: PeriodNames;
  hasPrevious: boolean;
  rows: BreakdownRow<K>[];
  selected: K | null;
  onPick: (key: K) => void;
  currency: string;
}) {
  const { rows, currency } = props;
  const pie = pieSlices(rows);
  const other = pie.slices.find((s) => s.kind === 'other');
  const share = (cents: number) => (pie.totalCents > 0 && cents > 0 ? shareText(cents / pie.totalCents) : '');

  const row = (r: BreakdownRow<K>, swatch: string | null, member = false) => (
    <tr key={String(r.key)} className={member ? 'spend-pie-member' : undefined}>
      <th scope="row">
        <span className="spend-pie-name">
          {swatch ? <span className={`spend-swatch ${swatch}`} aria-hidden="true" /> : <span className="spend-swatch none" aria-hidden="true" />}
          <button type="button" className="spend-bar-pick" aria-pressed={props.selected === r.key} onClick={() => props.onPick(r.key)}>
            {r.label}
          </button>
        </span>
      </th>
      <td className="spend-number">{money(r.cents, currency)}</td>
      <td className="spend-number spend-share">
        {share(r.cents) || <span className="visually-hidden">Not in the chart</span>}
      </td>
      {props.hasPrevious && <td className="spend-number spend-previous muted">{money(r.previousCents, currency)}</td>}
    </tr>
  );

  return (
    <section aria-labelledby={`${props.id}-heading`} className="spend-breakdown">
      <h3 id={`${props.id}-heading`}>{props.title}</h3>
      {rows.length === 0 ? (
        <p className="muted">{props.period.empty}</p>
      ) : (
        <div className="spend-pie-layout">
          {pie.slices.length > 0 ? (
            <Donut
              label={`Spending ${props.title.toLowerCase()}, ${props.period.current}: ${pie.slices.map((s) => `${sliceLabel(s)} ${shareText(s.share)}`).join(', ')}.`}
              slices={pie.slices}
              selected={props.selected}
              onPick={props.onPick}
              currency={currency}
            />
          ) : (
            <p className="muted">Only credits {props.period.current}, so there's nothing to chart.</p>
          )}
          <table className="spend-pie-table">
            <caption className="visually-hidden">
              {props.title}, {props.period.current}{props.hasPrevious ? ` and ${props.period.previous}` : ''}, with each one's share of the chart. Press a name to show only its transactions.
            </caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" className="spend-number">{props.period.currentHeading}</th>
                <th scope="col" className="spend-number">Share</th>
                {props.hasPrevious && <th scope="col" className="spend-number spend-previous">{props.period.previousHeading}</th>}
              </tr>
            </thead>
            <tbody>
              {pie.slices.filter((s) => s.kind === 'named').map((s) => row(s.row, `chart-slot-${s.slot}`))}
              {other && (
                <>
                  <tr className="spend-pie-other">
                    <th scope="row">
                      <span className="spend-pie-name">
                        <span className="spend-swatch chart-slot-other" aria-hidden="true" />
                        <span>Other <span className="muted">({other.members.length} smaller)</span></span>
                      </span>
                    </th>
                    <td className="spend-number">{money(other.cents, currency)}</td>
                    <td className="spend-number spend-share">{shareText(other.share)}</td>
                    {props.hasPrevious && (
                      <td className="spend-number spend-previous muted">{money(other.members.reduce((sum, m) => sum + m.previousCents, 0), currency)}</td>
                    )}
                  </tr>
                  {other.members.map((m) => row(m, 'chart-slot-other', true))}
                </>
              )}
              {pie.notDrawn.map((r) => row(r, null))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function sliceLabel<K>(s: Slice<BreakdownRow<K>>): string {
  return s.kind === 'named' ? s.row.label : 'Other';
}

const SIZE = 176;
const OUTER = 84;
const INNER = 54;

/**
 * The donut: one path per slice, 12 o'clock clockwise, with a 2px surface gap between slices.
 * Hovering (or touching) a slice names it in the middle. It's one image to assistive tech, named
 * by `label`; the table carries the numbers.
 */
function Donut<K extends string | number>(props: {
  label: string;
  slices: Slice<BreakdownRow<K>>[];
  selected: K | null;
  onPick: (key: K) => void;
  currency: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const holds = (s: Slice<BreakdownRow<K>>, key: K | null) =>
    key !== null && (s.kind === 'named' ? s.row.key === key : s.members.some((m) => m.key === key));
  const anySelected = props.slices.some((s) => holds(s, props.selected));
  const c = SIZE / 2;
  let at = 0;
  const shown = hover !== null ? props.slices[hover] : undefined;
  return (
    <svg className="spend-donut" viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} role="img" aria-label={props.label} onPointerLeave={() => setHover(null)}>
      {props.slices.map((s, i) => {
        const from = at;
        at += s.share;
        const classes = [
          'spend-slice',
          s.kind === 'named' ? `chart-slot-${s.slot}` : 'chart-slot-other',
          props.slices.length === 1 ? 'whole' : '',
          anySelected ? (holds(s, props.selected) ? 'selected' : 'dimmed') : '',
          s.kind === 'named' ? 'pickable' : '',
        ].filter(Boolean).join(' ');
        return (
          <path
            key={s.kind === 'named' ? String(s.row.key) : 'other'}
            d={arcPath(c, OUTER, INNER, from, i === props.slices.length - 1 ? 1 : at)}
            className={classes}
            data-slice={s.kind === 'named' ? s.row.label : 'Other'}
            onPointerEnter={() => setHover(i)}
            onClick={s.kind === 'named' ? () => props.onPick(s.row.key) : undefined}
          />
        );
      })}
      {shown && (
        <g className="spend-donut-center" aria-hidden="true">
          <text x={c} y={c - 12} textAnchor="middle" className="spend-donut-name">{clip(sliceLabel(shown), 14)}</text>
          <text x={c} y={c + 8} textAnchor="middle" className="spend-donut-amount">{money(shown.cents, props.currency)}</text>
          <text x={c} y={c + 26} textAnchor="middle" className="spend-donut-share">{shareText(shown.share)}</text>
        </g>
      )}
    </svg>
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
