import type { FlowMark } from './chart.js';

/**
 * The graphs' deposit and withdrawal lines (the Savings spec, "Line graph"): an SVG group drawn
 * behind the balance line, one line and marker per mark, faint to strong by amount. Colors come
 * from CSS classes (chart slot 3's green and the danger red), opacity from presentation
 * attributes, so nothing needs an inline style.
 */
export function FlowLines({ marks }: { marks: readonly FlowMark[] }) {
  return (
    <g className="savings-flows">
      {marks.map((m) => (
        <g key={`${m.date}-${m.kind}`} className={`savings-flow ${m.kind}`} data-date={m.date}>
          <line x1={m.x} x2={m.x} y1={m.y1} y2={m.y2} strokeOpacity={m.opacity.toFixed(2)} />
          <path d={m.marker} fillOpacity={m.opacity.toFixed(2)} />
        </g>
      ))}
    </g>
  );
}

/** The key under the six-month graph. The marks beside the words carry the color; the words carry the meaning. */
export function FlowLegend() {
  return (
    <p className="savings-flow-legend">
      Green <span className="savings-flow-key deposit" aria-hidden="true">▲</span> deposits, red{' '}
      <span className="savings-flow-key withdrawal" aria-hidden="true">▼</span> withdrawals;{' '}
      <span className="muted">transfers between your accounts aren't shown.</span>
    </p>
  );
}
