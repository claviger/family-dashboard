import { Link } from '@tanstack/react-router';
import { WEB_PANELS } from '../panels/registry.js';
import { cardTitleId } from './cardTitleId.js';
import { Icon, PanelBadge } from './PanelIcon.js';
import { useMe } from './useMe.js';

/**
 * One card per granted panel. The card's title is the link to the drill-down; the body is the
 * panel's Summary, which may hold its own controls (a link can't contain interactive content).
 */
export function Home() {
  const me = useMe().data!;
  if (me.panels.length === 0) {
    return <p className="muted">No panels are turned on for you yet. Ask your admin.</p>;
  }
  return (
    <div className="card-grid">
      {me.panels.map((id) => {
        const panel = WEB_PANELS[id];
        return (
          <section key={id} className={`card panel-${id}`} aria-labelledby={cardTitleId(id)}>
            <h2 id={cardTitleId(id)} className="card-title">
              <Link to="/$panelId" params={{ panelId: id }}>
                <PanelBadge id={id} />
                <span className="card-title-text">{panel.title}</span>
                <Icon name="chevron" className="card-chevron" />
              </Link>
            </h2>
            <panel.Summary />
          </section>
        );
      })}
    </div>
  );
}
