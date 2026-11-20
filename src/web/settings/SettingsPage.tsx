import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { TODOIST_LINK_ERRORS } from '../../shared/integrations.js';
import { SummaryViewPicker } from '../panels/todo/SummaryViewPicker.js';
import { useMe } from '../shell/useMe.js';
import { useTodoistLink } from './queries.js';
import { linkOutcomeFrom, TodoistSection, type LinkOutcome } from './TodoistSection.js';

/**
 * Personal settings at /settings (spec §7): the to-do summary view, and linking Todoist with the
 * chores project. Both need the To-do panel; Todoist also needs to be configured on the server.
 * Someone whose To-do panel was turned off but who still has a Todoist link sees that link, so
 * they can disconnect it.
 */
export function SettingsPage() {
  const me = useMe().data!;
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const navigate = useNavigate();
  // The link outcome arrives once in the URL; keep it for this visit and take it out of the URL,
  // so a reload doesn't show it again.
  const [outcome] = useState<LinkOutcome>(() => linkOutcomeFrom(searchStr));
  useEffect(() => {
    if (searchStr) void navigate({ to: '/settings', search: {}, replace: true });
  }, [searchStr, navigate]);
  const hasTodo = me.panels.includes('todo');
  const link = useTodoistLink(me.features.todoist);
  // Once shown, the Todoist section stays for this visit, so disconnecting can say it's done.
  const [showLinkWithoutPanel, setShowLinkWithoutPanel] = useState(false);
  if (!hasTodo && link.data?.linked === true && !showLinkWithoutPanel) setShowLinkWithoutPanel(true);
  const linkedWithoutPanel = !hasTodo && showLinkWithoutPanel;
  // A link error for someone the Todoist section isn't shown to (no To-do panel, no link) is shown
  // here, and focused like the section's own messages.
  const outcomeRef = useRef<HTMLParagraphElement>(null);
  const outcomeHere = me.features.todoist && !hasTodo && link.data?.linked === false && !linkedWithoutPanel && outcome?.kind === 'error';
  useEffect(() => {
    if (outcomeHere) outcomeRef.current?.focus();
  }, [outcomeHere]);

  return (
    <section className="settings-page">
      <Link to="/" className="drilldown-back">← Back</Link>
      <h2 className="page-title">Settings</h2>
      {!hasTodo && !linkedWithoutPanel && (
        <p className="muted">There's nothing to set here yet. Your admin hasn't turned on the To-do panel for you.</p>
      )}
      {hasTodo && (
        <section className="admin-section" aria-labelledby="todo-settings-heading">
          <h2 id="todo-settings-heading">To-do</h2>
          <p className="muted">Admins can see and edit your to-do list.</p>
          <div className="form-row">
            <SummaryViewPicker />
          </div>
        </section>
      )}
      {me.features.todoist && (hasTodo || linkedWithoutPanel) && <TodoistSection outcome={outcome} hasPanel={hasTodo} />}
      {outcomeHere && (
        <p ref={outcomeRef} tabIndex={-1} className="error" role="alert">{outcome?.kind === 'error' ? TODOIST_LINK_ERRORS[outcome.code] : null}</p>
      )}
    </section>
  );
}
