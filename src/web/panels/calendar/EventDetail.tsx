import type { CalendarEventDetail } from '../../../shared/calendar.js';
import { formatTime, longDay, READ_ONLY_EVENT_NOTES } from './format.js';

/** When an event happens, in words: "Wednesday, November 18, 9:00 AM to 10:00 AM", or "... to Friday, November 20" for all day. */
export function whenText(e: CalendarEventDetail['event'], today: string): string {
  const start = longDay(e.startDate, today);
  if (e.allDay) return e.endDate === e.startDate ? `${start}, all day` : `${start} to ${longDay(e.endDate, today)}`;
  const from = `${start}, ${formatTime(e.startTime!)}`;
  return e.endDate === e.startDate ? `${from} to ${formatTime(e.endTime!)}` : `${from} to ${longDay(e.endDate, today)}, ${formatTime(e.endTime!)}`;
}

/**
 * Event detail (spec §9.4, §9.5): title, when, location, description, the repeat in words, and
 * who added or last edited it from the dashboard, when that's known. Edit and Delete show only
 * when the event can be changed here (`canChange`).
 */
export function EventDetail({ detail, today, titleId, canChange, notice = null, error, busy, onEdit, onDelete, onClose }: {
  detail: CalendarEventDetail;
  /** Why this is shown as it is: the version last fetched (R5-M12), or a create read back (R5-M14). */
  notice?: string | null;
  today: string;
  titleId: string;
  canChange: boolean;
  error: string | null;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { event, series } = detail;
  return (
    <div className="event-detail">
      <h3 id={titleId} tabIndex={-1}>{event.title}</h3>
      {notice && <p className="notice" role="status">{notice}</p>}
      <p>{whenText(event, today)}</p>
      {series?.repeatText && <p><span className="muted">Repeats:</span> {series.repeatText}</p>}
      {event.seriesId === event.id && <p className="muted">This is the whole series. Editing or deleting it changes every event in it.</p>}
      {event.location && <p><span className="muted">Where:</span> {event.location}</p>}
      {event.description && <p className="event-description">{event.description}</p>}
      {(event.createdBy || event.updatedBy) && (
        <p className="muted">
          {event.createdBy && `Added by ${event.createdBy.name}.`}
          {event.createdBy && event.updatedBy && ' '}
          {event.updatedBy && `Edited by ${event.updatedBy.name}.`}
        </p>
      )}
      {event.readOnly && <p className="notice">{READ_ONLY_EVENT_NOTES[event.readOnly]}</p>}
      {event.htmlLink && (
        <p><a href={event.htmlLink} target="_blank" rel="noopener noreferrer">Open in Google Calendar</a></p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-row">
        {canChange && !event.readOnly && (
          <>
            <button type="button" className="primary" onClick={onEdit} disabled={busy}>Edit</button>
            <button type="button" onClick={onDelete} disabled={busy}>Delete</button>
          </>
        )}
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

/**
 * Spec §9.4: changing or deleting a repeating event asks whether it's this one or all of them.
 * "This and following" isn't offered.
 */
export function ScopeChoice({ titleId, action, title, onPick, onCancel }: {
  titleId: string;
  action: 'edit' | 'delete';
  title: string;
  onPick: (scope: 'this' | 'all') => void;
  onCancel: () => void;
}) {
  return (
    <div className="event-scope">
      <h3 id={titleId} tabIndex={-1}>{action === 'edit' ? `Change "${title}"` : `Delete "${title}"`}</h3>
      <p>
        {action === 'edit'
          ? 'This event repeats. Change only this one, or every event in the series?'
          : "This event repeats. Delete only this one, or every event in the series? It's deleted from Google Calendar."}
      </p>
      <div className="form-row">
        <button type="button" className="primary" onClick={() => onPick('this')}>This event</button>
        <button type="button" onClick={() => onPick('all')}>All events</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
