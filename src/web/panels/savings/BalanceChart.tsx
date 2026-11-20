import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { SAVINGS_MESSAGES, type BalanceSeries } from '../../../shared/savings.js';
import { chartGeometry, flowMarks, nearestIndex, type ChartBox } from './chart.js';
import { FlowLegend, FlowLines } from './FlowLines.js';
import { axisLabels, dayLabel, flowDayLine, flowsSummaryLine, joinsLine, money, monthLabel, shortMonth } from './format.js';

/** The viewBox is the frame's own width in pixels, so the axis text stays 12px on a phone. */
const HEIGHT = 220;
const MIN_WIDTH = 260;
/** A tapped day's tooltip goes away by itself after this long. */
const TAP_TIP_MS = 4_000;
const box = (width: number): ChartBox => ({ width, height: HEIGHT, left: 64, right: 16, top: 28, bottom: 28 });

/**
 * The frame's width, kept up to date. A callback ref in state, so the observer is attached whenever
 * the frame appears, including after a first render without points (when there's no frame yet).
 */
export function useWidth(initial = 640, min = MIN_WIDTH) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    if (!el) return;
    const set = () => setWidth(Math.max(min, Math.round(el.getBoundingClientRect().width)));
    set();
    const observer = new ResizeObserver(set);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, min]);
  return [setEl, width] as const;
}

/**
 * The total of the shown accounts over six months (the Savings spec, "Line graph"; the dataviz
 * guidance): one series, so no legend, the heading names it. Inline SVG, no chart library (main
 * spec §15); colors only from the panel's tokens through CSS classes. A 2px line, solid hairline
 * grid, an end dot with a surface ring and the latest value beside it, and a ringed marker where an
 * account was linked part way through (the sentence under the graph names it, so the step up isn't
 * a mystery). Pointer hover and the arrow keys (the frame takes focus) move a crosshair to the
 * nearest day and show its total; a tap shows it until a second tap, a tap elsewhere, or a few
 * seconds pass. The SVG and the tooltip are hidden from screen readers: keyboard moves are read out
 * by their own live region, the latest total is text above the graph, and the month-end totals are
 * a table behind "Show as a table", so no value needs the tooltip.
 *
 * Behind the line, a full-height line for each day with a deposit (green, ▲ above it) or a
 * withdrawal (red, ▼), fainter the smaller it is against the largest in the six months, so a
 * paycheck stands out from market moves and small bills stay faint (FlowLines). Transfers between
 * the shown accounts aren't flows (the server pairs them out). The tooltip and the spoken text add
 * the day's deposits and withdrawals; a legend under the graph keys the colors and markers, and a
 * visually hidden line totals them.
 */
export function BalanceChart({ series, today }: { series: BalanceSeries; today: string }) {
  const headingId = useId();
  const hintId = useId();
  const [frameRef, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  /** What the arrow keys last read, for screen readers; pointer moves don't change it. */
  const [spoken, setSpoken] = useState('');
  const tapped = useRef(false);
  const tapTimer = useRef<number | undefined>(undefined);
  const svgRef = useRef<SVGSVGElement>(null);
  const BOX = box(width);
  const g = chartGeometry(series.points, series.rangeStart, today, BOX);
  const filling = series.startsOn !== null && series.startsOn > series.rangeStart;
  const labels = g ? axisLabels(g.yTicks.map((t) => t.cents)) : [];
  const joins = g ? series.joins.flatMap((j) => {
    const p = g.points.find((x) => x.date === j.date);
    return p ? [{ ...j, x: p.x, y: p.y }] : [];
  }) : [];
  const joined = joinsLine(series.joins);
  const marks = g ? flowMarks(g, series.flows, BOX) : [];
  const flowsByDay = new Map(series.flows.map((f) => [f.date, f]));
  const flowsText = flowsSummaryLine(series.flows.filter((f) => g && f.date >= g.points[0]!.date));

  // A tapped tooltip: a tap anywhere outside the graph clears it.
  useEffect(() => {
    if (hover === null || !tapped.current) return;
    const away = (e: globalThis.PointerEvent) => {
      if (svgRef.current && e.target instanceof Node && svgRef.current.contains(e.target)) return;
      tapped.current = false;
      setHover(null);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [hover]);
  useEffect(() => () => window.clearTimeout(tapTimer.current), []);

  const indexAt = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return nearestIndex(g!, ((e.clientX - rect.left) / rect.width) * BOX.width);
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!g || e.pointerType !== 'mouse') return;
    setHover(indexAt(e));
  };
  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    if (!g || e.pointerType === 'mouse') return;
    window.clearTimeout(tapTimer.current);
    // A second tap on the graph while a tooltip shows closes it.
    if (tapped.current && hover !== null) {
      tapped.current = false;
      setHover(null);
      return;
    }
    tapped.current = true;
    setHover(indexAt(e));
    tapTimer.current = window.setTimeout(() => {
      tapped.current = false;
      setHover(null);
    }, TAP_TIP_MS);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!g) return;
    const lastIndex = g.points.length - 1;
    const at = hover ?? lastIndex;
    const step = e.shiftKey ? 7 : 1;
    const next =
      e.key === 'ArrowLeft' ? Math.max(0, at - step)
      : e.key === 'ArrowRight' ? Math.min(lastIndex, at + step)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? lastIndex
      : e.key === 'Escape' ? null
      : undefined;
    if (next === undefined) return;
    e.preventDefault();
    tapped.current = false;
    setHover(next);
    const p = next === null ? null : g.points[next];
    const flowLine = p ? flowDayLine(flowsByDay.get(p.date)) : null;
    setSpoken(p ? `${dayLabel(p.date)}: ${money(p.cents)}${flowLine ? `. ${flowLine}` : ''}` : '');
  };
  const point = g && hover !== null ? (g.points[hover] ?? null) : null;
  const pointFlows = point ? flowDayLine(flowsByDay.get(point.date)) : null;
  const end = g?.last;
  // The end label sits above the dot, or below it when the dot is at the top of the plot.
  const endLabelY = end ? (end.y - 12 < 12 ? end.y + 20 : end.y - 12) : 0;
  const tipSide = point ? (point.x < BOX.width * 0.2 ? 'right' : point.x > BOX.width * 0.8 ? 'left' : '') : '';

  return (
    <section className="savings-block savings-chart" aria-labelledby={headingId}>
      <h3 id={headingId}>Total, last six months</h3>
      {!g ? (
        <p className="muted">The graph starts once the accounts' first balances are in.</p>
      ) : (
        <>
          <p>
            Total now <strong className="savings-amount">{money(g.last.cents)}</strong> <span className="muted">({dayLabel(g.last.date)})</span>
          </p>
          <div
            ref={frameRef}
            className="savings-chart-frame"
            tabIndex={0}
            role="group"
            aria-label="Graph of the total"
            aria-describedby={hintId}
            onKeyDown={onKey}
            onBlur={() => {
              if (!tapped.current) setHover(null);
            }}
          >
            <span id={hintId} className="visually-hidden">Left and right arrows read the total day by day.</span>
            <span className="visually-hidden" aria-live="polite">{spoken}</span>
            {flowsText && <span className="visually-hidden">{flowsText}</span>}
            <svg
              ref={svgRef}
              viewBox={`0 0 ${BOX.width} ${BOX.height}`}
              width={BOX.width}
              height={BOX.height}
              aria-hidden="true"
              focusable="false"
              onPointerMove={onMove}
              onPointerDown={onDown}
              onPointerLeave={(e) => {
                if (e.pointerType === 'mouse') setHover(null);
              }}
            >
              {g.yTicks.map((t, i) => (
                <g key={t.cents}>
                  <line className="savings-chart-grid" x1={BOX.left} x2={BOX.width - BOX.right} y1={t.y} y2={t.y} />
                  <text className="savings-chart-axis" x={BOX.left - 8} y={t.y} textAnchor="end" dominantBaseline="middle">{labels[i]}</text>
                </g>
              ))}
              {g.xTicks.map((t) => (
                <text key={t.month} className="savings-chart-axis" x={t.x} y={BOX.height - 8} textAnchor="middle">{shortMonth(t.month)}</text>
              ))}
              {/* Deposits and withdrawals: behind the balance line, faint for small ones. */}
              <FlowLines marks={marks} />
              <path className="savings-chart-line" d={g.path} />
              {/* Where an account was linked part way through: a ringed marker on the line. */}
              {joins.map((j) => <circle key={`${j.date}-${j.nickname}`} className="savings-chart-join" cx={j.x} cy={j.y} r={4} />)}
              {point && <line className="savings-chart-crosshair" x1={point.x} x2={point.x} y1={BOX.top} y2={BOX.height - BOX.bottom} />}
              {!point && end && (
                <text className="savings-chart-end" x={end.x} y={endLabelY} textAnchor="end">{money(end.cents)}</text>
              )}
              <circle className="savings-chart-dot" cx={(point ?? g.last).x} cy={(point ?? g.last).y} r={5} />
              {/* The hit area: the whole plot, far bigger than the line; the crosshair snaps to the nearest day. */}
              <rect className="savings-chart-hit" x={BOX.left} y={0} width={BOX.width - BOX.left} height={BOX.height - BOX.bottom} />
            </svg>
            {point && (
              <span
                className={`savings-chart-tip ${tipSide}`.trim()}
                style={{ left: `${(point.x / BOX.width) * 100}%`, top: `${(point.y / BOX.height) * 100}%` }}
                aria-hidden="true"
              >
                <strong>{money(point.cents)}</strong>
                {dayLabel(point.date)}
                {pointFlows && <span className="savings-chart-tip-flows">{pointFlows}</span>}
              </span>
            )}
          </div>
        </>
      )}
      {g && marks.length > 0 && <FlowLegend />}
      {g && joined && <p className="muted">{joined}</p>}
      {filling && <p className="muted">{SAVINGS_MESSAGES.graphFilling(dayLabel(series.startsOn!))}</p>}
      {g && series.monthEnds.length > 0 && (
        <details className="savings-chart-table">
          <summary>Show as a table</summary>
          <table>
            <caption className="visually-hidden">Month-end totals</caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Total at month end</th>
              </tr>
            </thead>
            <tbody>
              {series.monthEnds.map((m) => (
                <tr key={m.month}>
                  <th scope="row">{monthLabel(m.month)}{m.month === today.slice(0, 7) ? ' (so far)' : ''}</th>
                  <td>{money(m.cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
