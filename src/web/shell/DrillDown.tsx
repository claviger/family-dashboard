import { Link, useParams } from '@tanstack/react-router';
import { PanelIdSchema } from '../../shared/panels.js';
import { WEB_PANELS } from '../panels/registry.js';
import { PanelBadge } from './PanelIcon.js';
import { useMe } from './useMe.js';

export function DrillDown() {
  const { panelId } = useParams({ from: '/$panelId' });
  const me = useMe().data!;
  const parsed = PanelIdSchema.safeParse(panelId);
  if (!parsed.success || !me.panels.includes(parsed.data)) {
    return (
      <section className="drilldown">
        <Link to="/" className="drilldown-back">← Back</Link>
        <p>You don't have access to this panel.</p>
      </section>
    );
  }
  const panel = WEB_PANELS[parsed.data];
  return (
    <section className={`drilldown panel-${panel.id}`}>
      <Link to="/" className="drilldown-back">← Back</Link>
      <h2 className="drilldown-title">
        <PanelBadge id={panel.id} />
        {panel.title}
      </h2>
      <panel.DrillDown />
    </section>
  );
}
