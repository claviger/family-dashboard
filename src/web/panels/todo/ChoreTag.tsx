import { Link } from '@tanstack/react-router';
import { useMe } from '../../shell/useMe.js';

/**
 * The Chore tag on to-dos created by the Chores panel (spec §10.1). It links to the Chores
 * drill-down when the viewer has that panel; otherwise it's plain text.
 */
export function ChoreTag({ title }: { title: string }) {
  const me = useMe().data!;
  if (!me.panels.includes('chores')) return <span className="chore-tag">Chore</span>;
  return (
    <Link to="/$panelId" params={{ panelId: 'chores' }} className="chore-tag" aria-label={`Chore: ${title}`}>
      Chore
    </Link>
  );
}
