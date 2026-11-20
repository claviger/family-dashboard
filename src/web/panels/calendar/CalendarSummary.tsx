import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useRef } from 'react';
import { cardTitleId } from '../../shell/cardTitleId.js';
import { useMe } from '../../shell/useMe.js';
import { summaryAgenda } from './agenda.js';
import { CARD_EVENT_KEY, openEventId, todayIn } from './calendarView.js';
import { CalendarStatus } from './CalendarStatus.js';
import { EventItem } from './CalendarViews.js';
import { dayHeading } from './format.js';
import { useCalendarSummary } from './queries.js';
import { useEventDialog, type DialogSearch } from './useEventDialog.js';
import { useStatusLine } from './useStatusLine.js';

/**
 * Home card (spec §9.3): an agenda from today through the next 6 days, each event once, all-day
 * events first within a day, up to 6 events, then "+N more this week", which opens the agenda.
 * Without a linked calendar it says so, and admins get a link to connect it (spec §9.1). A failed
 * refresh shows its error over the events it already has (R5-I1), as the To-do card does.
 *
 * Each event is a button, named with its title, day, and time, that opens the same event dialog
 * as the drill-down (`useEventDialog`), over the home page. The open event is in the query string
 * as `?calendarEvent=<id>`, so Back closes it and a link opens it. Focus goes back to the event's
 * button, or to the card's title when the event is gone (deleted, or moved by an "All events" edit).
 */
export function CalendarSummary() {
  const me = useMe().data!;
  const isAdmin = me.user.role === 'admin';
  const summary = useCalendarSummary();
  const search = useSearch({ from: '/' });
  const navigate = useNavigate({ from: '/' });
  const [status, setStatus] = useStatusLine();
  const listRef = useRef<HTMLDivElement>(null);
  const w = summary.data;

  // Opening or closing the dialog leaves the home page where it was scrolled to.
  function go(next: DialogSearch, opts: { replace?: boolean } = {}) {
    void navigate({ search: { ...search, [CARD_EVENT_KEY]: 'event' in next ? next.event : search[CARD_EVENT_KEY] }, replace: opts.replace, resetScroll: false });
  }

  const { openEvent, dialog } = useEventDialog({
    openId: openEventId(search, CARD_EVENT_KEY),
    navigate: go,
    window: w,
    today: w?.today ?? todayIn(me.family.timeZone),
    fallbackFocus: () => document.getElementById(cardTitleId('calendar'))?.querySelector<HTMLElement>('a') ?? null,
    openerFor: (id) => listRef.current?.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(id)}"]`) ?? null,
    onStatus: setStatus,
  });

  return (
    <>
      {cardBody()}
      {dialog}
    </>
  );

  function cardBody() {
    if (summary.isPending) return <p className="muted">Loading…</p>;
    if (!w) return <p className="error">{summary.error?.message ?? "Couldn't load the calendar."}</p>;
    const refreshError = summary.error ? <p className="error">{summary.error.message}</p> : null;
    if (!w.freshness.connected) {
      return (
        <div className="calendar-summary">
          {refreshError}
          <p className="muted">Calendar isn't connected yet.</p>
          {isAdmin && <Link to="/admin" hash="integrations" className="todo-more">Connect it in Integrations</Link>}
        </div>
      );
    }
    const { days, more } = summaryAgenda(w.events, w.today, w.end);
    return (
      <div className="calendar-summary" ref={listRef}>
        {refreshError}
        <CalendarStatus freshness={w.freshness} receivedAt={summary.dataUpdatedAt} isAdmin={isAdmin} />
        {days.length === 0 && <p className="muted">Nothing on the calendar this week.</p>}
        {days.map((day) => (
          <div role="group" key={day.date} className="calendar-day" aria-labelledby={`card-day-${day.date}`}>
            <h3 id={`card-day-${day.date}`} className="calendar-day-heading">{dayHeading(day.date, w.today)}</h3>
            <ul className="calendar-list">
              {day.entries.map((entry) => (
                <EventItem key={entry.event.id} entry={entry} withEnd={false} onOpen={openEvent} day={dayHeading(day.date, w.today)} />
              ))}
            </ul>
          </div>
        ))}
        {more > 0 && (
          <Link to="/$panelId" params={{ panelId: 'calendar' }} search={{ view: 'agenda' }} className="todo-more">
            +{more} more this week
          </Link>
        )}
        <p role="status" className="muted todo-status">{status}</p>
      </div>
    );
  }
}
