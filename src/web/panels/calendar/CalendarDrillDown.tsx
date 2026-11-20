import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useMe } from '../../shell/useMe.js';
import { useMediaQuery } from '../../useMediaQuery.js';
import { CALENDAR_VIEWS, newEventDate, openEventId, rangeFor, rangeTitle, step, timesInLine, todayIn, VIEW_LABELS, viewFromSearch, type CalendarView } from './calendarView.js';
import { CalendarStatus } from './CalendarStatus.js';
import { AgendaView, MonthView, WeekView } from './CalendarViews.js';
import { useCalendarWindow, useRefreshCalendar } from './queries.js';
import { useEventDialog } from './useEventDialog.js';
import { useStatusLine } from './useStatusLine.js';

/** Wide enough for the week's columns and the month's table; narrower screens get lists (spec §9.4). */
export const WIDE = '(min-width: 768px)';

const RANGE_ID = 'calendar-range';

/**
 * Drill-down (spec §9.4): agenda, week, and month views, with Previous, Today, Next, and a refresh
 * button that skips the 5-minute cache. The view, the day it shows, the open event, and a new
 * event's dialog are in the query string (`?view=&date=&event=&new=1`, spec §7), so the back
 * button and links work. Without a view, phones get the agenda and wider screens the month; the
 * month view reads as an agenda on a phone.
 *
 * An event opens in the event dialog (`useEventDialog`, shared with the home card): its detail,
 * Edit, Delete, "This event" or "All events", conflicts, the read-only fallback, and New event.
 * Its history, focus, and read-only rules are described there. After a delete or an "All events"
 * save, focus goes to the range heading (R5-M10).
 */
export function CalendarDrillDown() {
  const me = useMe().data!;
  const isAdmin = me.user.role === 'admin';
  const search = useSearch({ from: '/$panelId' });
  const navigate = useNavigate({ from: '/$panelId' });
  const wide = useMediaQuery(WIDE);
  const today = todayIn(me.family.timeZone);
  const { view, anchor } = viewFromSearch(search, today, wide);
  const range = rangeFor(view, anchor);
  const win = useCalendarWindow(range.start, range.end);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refresh = useRefreshCalendar({ onError: (err) => setRefreshError(err.message) });
  const [status, setStatus] = useStatusLine();
  const rangeRef = useRef<HTMLHeadingElement>(null);
  const newRef = useRef<HTMLButtonElement>(null);

  const openId = openEventId(search, 'event');
  const createOpen = search.new === 1 && openId === null;

  type SearchChange = { view?: CalendarView; date?: string; event?: string | undefined; new?: 1 | undefined };
  function go(next: SearchChange, opts: { replace?: boolean } = {}) {
    // Opening or closing a dialog leaves the page where it was scrolled to; a new view or day starts at the top.
    const dialogOnly = Object.keys(next).every((key) => key === 'event' || key === 'new');
    void navigate({
      search: {
        ...search,
        view: next.view ?? view,
        date: next.date ?? anchor,
        event: 'event' in next ? next.event : search.event,
        new: 'new' in next ? next.new : search.new,
      },
      replace: opts.replace,
      resetScroll: dialogOnly ? false : undefined,
    });
  }

  const data = win.data;
  const shownToday = data?.today ?? today;
  const { openEvent, startCreate, canChange, dialog } = useEventDialog({
    openId,
    createOpen,
    navigate: go,
    window: data,
    today: shownToday,
    fallbackFocus: () => rangeRef.current,
    onStatus: setStatus,
    newEventDate: (day) => newEventDate(view, anchor, day),
  });
  const onOpen = data?.freshness.connected ? openEvent : undefined;

  const zoneLine = timesInLine(me.family.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const stepTo = (date: string) => {
    setStatus('');
    go({ date });
  };

  return (
    <div className="calendar-drilldown">
      <div className="calendar-toolbar">
        <nav aria-label="Calendar views" className="calendar-views">
          {CALENDAR_VIEWS.map((v) => (
            <button key={v} type="button" aria-pressed={v === view} onClick={() => { setStatus(''); go({ view: v }); }}>{VIEW_LABELS[v]}</button>
          ))}
        </nav>
        <div className="calendar-steps">
          <button type="button" onClick={() => stepTo(step(view, anchor, -1))} aria-label={`Previous ${view === 'month' ? 'month' : 'week'}`}>Previous</button>
          <button type="button" onClick={() => stepTo(today)}>Today</button>
          <button type="button" onClick={() => stepTo(step(view, anchor, 1))} aria-label={`Next ${view === 'month' ? 'month' : 'week'}`}>Next</button>
          <button
            type="button"
            disabled={refresh.isPending || !data?.freshness.connected}
            onClick={() => {
              setRefreshError(null);
              setStatus('');
              refresh.mutate(range);
            }}
          >
            {refresh.isPending ? 'Refreshing…' : 'Refresh'}
          </button>
          {canChange && (
            <button ref={newRef} type="button" className="primary" onClick={() => startCreate(newRef.current)}>
              New event
            </button>
          )}
        </div>
      </div>
      <h3 id={RANGE_ID} ref={rangeRef} tabIndex={-1} className="calendar-range" aria-live="polite">{rangeTitle(view, anchor)}</h3>
      {zoneLine && <p className="muted calendar-zone">{zoneLine}</p>}
      <p role="status" className="muted todo-status">{status}</p>
      {refreshError && <p className="error" role="alert">{refreshError}</p>}
      {win.isPending && <p className="muted">Loading…</p>}
      {/* A failed refetch shows over the events already here (R5-I1). */}
      {win.error && <p className="error">{win.error.message}</p>}
      {data && !data.freshness.connected && (
        <p className="muted">
          Calendar isn't connected yet.
          {isAdmin && <> <Link to="/admin" hash="integrations">Connect it in Integrations</Link></>}
        </p>
      )}
      {data?.freshness.connected && (
        // The previous window stays on screen while the next one loads, dimmed and busy (R5-M9).
        <div className="calendar-view" aria-busy={win.isPlaceholderData || undefined}>
          <CalendarStatus freshness={data.freshness} receivedAt={win.dataUpdatedAt} isAdmin={isAdmin} />
          {view === 'agenda' && <AgendaView events={data.events} start={range.start} end={range.end} today={shownToday} onOpen={onOpen} />}
          {view === 'week' && (wide
            ? <WeekView events={data.events} start={range.start} end={range.end} today={shownToday} onOpen={onOpen} />
            : <AgendaView events={data.events} start={range.start} end={range.end} today={shownToday} onOpen={onOpen} />)}
          {view === 'month' && (wide
            ? <MonthView events={data.events} anchor={anchor} today={shownToday} onOpen={onOpen} onShowDay={(date) => go({ view: 'agenda', date })} labelledBy={RANGE_ID} />
            : <AgendaView events={data.events} start={range.start} end={range.end} today={shownToday} onOpen={onOpen} skipEmpty />)}
        </div>
      )}
      {dialog}
    </div>
  );
}
