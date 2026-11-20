import type { CalendarEvent } from '../../../shared/calendar.js';
import { addDays } from '../../../shared/dates.js';
import { agendaDays, entryTime, type AgendaDay, type AgendaEntry } from './agenda.js';
import { monthWeeks } from './calendarView.js';
import { dayHeading, eventButtonLabel, formatTime, longDay, weekdayNames } from './format.js';

/** Opens an event's detail. Absent, events are shown as text. */
export type OpenEvent = ((event: CalendarEvent, opener: HTMLElement) => void) | undefined;

/**
 * One event in a list: its time and title, as a button that opens it when `onOpen` is given.
 * `day`: the date in words, for the month view and the home card, where it goes into the button's
 * name (R5-I2). The button carries the event's id, so a page can find it again to return focus.
 */
export function EventItem({ entry, withEnd, onOpen, day = null }: { entry: AgendaEntry; withEnd: boolean; onOpen: OpenEvent; day?: string | null }) {
  const time = entryTime(entry, (t) => formatTime(t), withEnd);
  const content = (
    <>
      <span className="calendar-time">{time}</span>
      <span className="todo-title">{entry.event.title}</span>
    </>
  );
  return (
    <li className="calendar-entry">
      {onOpen ? (
        <button type="button" className="calendar-event" data-event-id={entry.event.id} onClick={(e) => onOpen(entry.event, e.currentTarget)} aria-label={eventButtonLabel(entry.event.title, time, day)}>
          {content}
        </button>
      ) : (
        <span className="calendar-event">{content}</span>
      )}
    </li>
  );
}

/** A day: its heading, then its events. A group named by the heading, not a landmark (R5-M7). */
function DayList({ day, today, onOpen, headingLevel }: { day: AgendaDay; today: string; onOpen: OpenEvent; headingLevel: 'h3' | 'h4' }) {
  const Heading = headingLevel;
  const id = `day-${day.date}`;
  return (
    <div role="group" className={day.date === today ? 'calendar-day today' : 'calendar-day'} aria-labelledby={id}>
      <div className="calendar-day-head">
        <span className="calendar-day-num" aria-hidden="true">{Number(day.date.slice(8))}</span>
        <Heading id={id} className="calendar-day-heading">
          {dayHeading(day.date, today)}
          {day.date === today ? <span className="visually-hidden">, {longDay(day.date, today)}</span> : null}
        </Heading>
      </div>
      {day.entries.length === 0 ? (
        <p className="muted calendar-empty">No events</p>
      ) : (
        <ul className="calendar-list">
          {day.entries.map((entry) => <EventItem key={entry.event.id} entry={entry} withEnd onOpen={onOpen} />)}
        </ul>
      )}
    </div>
  );
}

/**
 * The agenda (spec §9.4): each day with its events. With `skipEmpty`, days with nothing on them
 * are left out, which is how the month view reads on a phone.
 */
export function AgendaView({ events, start, end, today, onOpen, skipEmpty = false }: {
  events: CalendarEvent[]; start: string; end: string; today: string; onOpen: OpenEvent; skipEmpty?: boolean;
}) {
  const days = agendaDays(events, start, end).filter((d) => !skipEmpty || d.entries.length > 0);
  if (days.length === 0) return <p className="muted">Nothing on the calendar.</p>;
  return <div className="calendar-agenda">{days.map((day) => <DayList key={day.date} day={day} today={today} onOpen={onOpen} headingLevel="h3" />)}</div>;
}

/** The week (spec §9.4): a column per day on wide screens, the days one below another on narrow ones. */
export function WeekView({ events, start, end, today, onOpen }: { events: CalendarEvent[]; start: string; end: string; today: string; onOpen: OpenEvent }) {
  return (
    <div className="calendar-week">
      {agendaDays(events, start, end).map((day) => (
        <div key={day.date} className={day.date === today ? 'calendar-week-day today' : 'calendar-week-day'}>
          <DayList day={day} today={today} onOpen={onOpen} headingLevel="h3" />
        </div>
      ))}
    </div>
  );
}

/** At most this many events in a month cell; the rest are "+N more". */
const PER_CELL = 3;

/**
 * The month (spec §9.4), kept simple and accessible: a table named by the range heading
 * (`labelledBy`, R5-I2) with a real header row for the days of the week, a cell per day with its
 * date, its first few events (each button named with its date), and "+N more", which opens the
 * agenda at that day.
 */
export function MonthView({ events, anchor, today, onOpen, onShowDay, labelledBy }: {
  events: CalendarEvent[]; anchor: string; today: string; onOpen: OpenEvent; onShowDay: (date: string) => void; labelledBy: string;
}) {
  const weeks = monthWeeks(anchor);
  const byDate = new Map(agendaDays(events, weeks[0]![0]!, addDays(weeks.at(-1)![6]!, 1)).map((d) => [d.date, d]));
  const month = anchor.slice(0, 7);
  const names = weekdayNames();
  return (
    <table className="calendar-month" aria-labelledby={labelledBy}>
      <thead>
        <tr>
          {names.map((n) => (
            <th key={n.long} scope="col">
              <span aria-hidden="true">{n.short}</span>
              <span className="visually-hidden">{n.long}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week) => (
          <tr key={week[0]}>
            {week.map((date) => {
              const day = byDate.get(date) ?? { date, entries: [] };
              const shown = day.entries.slice(0, PER_CELL);
              const more = day.entries.length - shown.length;
              const classes = ['calendar-cell', date.slice(0, 7) === month ? '' : 'other-month', date === today ? 'today' : ''].filter(Boolean).join(' ');
              return (
                <td key={date} className={classes} aria-current={date === today ? 'date' : undefined}>
                  <span className="calendar-date" aria-hidden="true">{Number(date.slice(8))}</span>
                  <span className="visually-hidden">{longDay(date, today)}{day.entries.length === 0 ? ', no events' : ''}</span>
                  {shown.length > 0 && (
                    <ul className="calendar-list">
                      {shown.map((entry) => <EventItem key={entry.event.id} entry={entry} withEnd={false} onOpen={onOpen} day={longDay(date, today)} />)}
                    </ul>
                  )}
                  {more > 0 && (
                    <button type="button" className="calendar-more" onClick={() => onShowDay(date)} aria-label={`${more} more on ${longDay(date, today)}`}>
                      +{more} more
                    </button>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
