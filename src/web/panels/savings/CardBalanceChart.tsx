import { useId } from 'react';
import type { BalanceSeries } from '../../../shared/savings.js';
import { useWidth } from './BalanceChart.js';
import { chartGeometry, flowMarks, type ChartBox } from './chart.js';
import { FlowLines } from './FlowLines.js';
import { cardGraphLine, dayLabel } from './format.js';

const HEIGHT = 96;
const box = (width: number): ChartBox => ({ width, height: HEIGHT, left: 4, right: 8, top: 14, bottom: 20 });

/**
 * The home card's graph (the Savings spec, "Home card"): the shown accounts' total over the last
 * month with the same deposit and withdrawal lines as the drill-down, compact, no axes: the first
 * and last day under it, and the latest total is the card's Total. Not interactive; the SVG is
 * hidden from screen readers and the caption under it is its text ("Last month: from $A to $B;
 * deposits $X, withdrawals $Y"), its ▲ and ▼ keying the lines. Nothing with fewer than two points.
 */
export function CardBalanceChart({ series }: { series: BalanceSeries }) {
  const captionId = useId();
  const [frameRef, width] = useWidth(320, 200);
  if (series.points.length < 2) return null;
  const BOX = box(width);
  const today = series.points.at(-1)!.date;
  const g = chartGeometry(series.points, series.rangeStart, today, BOX)!;
  const marks = flowMarks(g, series.flows, BOX);
  const first = g.points[0]!;
  return (
    <figure className="savings-card-chart" aria-labelledby={captionId}>
      <div ref={frameRef} className="savings-card-chart-frame">
        <svg viewBox={`0 0 ${BOX.width} ${BOX.height}`} width={BOX.width} height={BOX.height} aria-hidden="true" focusable="false">
          <line className="savings-chart-grid" x1={BOX.left} x2={BOX.width - BOX.right} y1={BOX.height - BOX.bottom} y2={BOX.height - BOX.bottom} />
          <FlowLines marks={marks} />
          <path className="savings-chart-line" d={g.path} />
          <circle className="savings-chart-dot" cx={g.last.x} cy={g.last.y} r={4} />
          <text className="savings-chart-axis" x={first.x} y={BOX.height - 4} textAnchor="start">{dayLabel(first.date)}</text>
          <text className="savings-chart-axis" x={BOX.width - BOX.right} y={BOX.height - 4} textAnchor="end">{dayLabel(g.last.date)}</text>
        </svg>
      </div>
      <figcaption id={captionId} className="todo-due">
        {cardGraphLine(g.points, series.flows.filter((f) => f.date >= first.date))}
        {marks.length > 0 && (
          <span className="savings-card-chart-key" aria-hidden="true">
            {' '}<span className="savings-flow-key deposit">▲</span> in <span className="savings-flow-key withdrawal">▼</span> out
          </span>
        )}
      </figcaption>
    </figure>
  );
}
