import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CalendarEventInput } from '../../../shared/calendar.js';
import { zoneName } from './calendarView.js';
import {
  followStartWeekday, formChanged, repeatStartFor, toEventInput, withAllDay, withStart, type EventFormValues, type FormField, type FormMode,
} from './eventFormValues.js';
import { RepeatEditor, type FieldHooks } from './RepeatEditor.js';

const PROBLEM_ID = 'event-form-problem';

/** Space-separated ids, leaving out the missing ones; undefined when there are none. */
function ids(...list: (string | undefined)[]): string | undefined {
  const present = list.filter(Boolean);
  return present.length > 0 ? present.join(' ') : undefined;
}

/**
 * The create and edit form (spec §9.4): title, all day, start and end in the family time zone,
 * location, description, and the repeat. `notice` is shown at the top (the conflict message,
 * spec §9.6) and `error` next to the buttons. Fields the dashboard can't change are read-only with
 * a note: a description Google keeps as HTML, the all-day switch for a whole series, a repeat
 * the editor can't represent (spec §9.4: "Edit the repeat in Google Calendar"), and the dates and
 * times of a series "All events" can't move (`mode.moveBlocked`, with why).
 *
 * Problems are checked here before saving, as ChoreForm does (R5-I4): Save moves focus to the
 * first field to fix, and the fields with the problem are marked `aria-invalid` and point to the
 * line that says what's wrong (`aria-describedby`). Once a Save has found one, the line follows
 * the form as it's fixed.
 *
 * `locked` (R5-M14): a create whose answer was lost may have been saved, so every field is locked
 * with that message, and Save sends exactly the same event again.
 *
 * The form keeps what the person typed until Save or Cancel: its parent gives it a new `key` only
 * when a conflict reloads the event (M-1), never because the event was fetched again. It tells the
 * parent whether anything changed (`onChange`), so Cancel and Escape can ask first (R5-M5).
 */
export function EventForm(props: {
  titleId: string;
  heading: string;
  initial: EventFormValues;
  mode: FormMode;
  repeatReadOnly: { text: string | null; note: string } | null;
  descriptionLocked: boolean;
  timeZone: string;
  busy: boolean;
  notice?: string | null;
  locked?: string | null;
  error?: string | null;
  onSubmit: (input: CalendarEventInput) => void;
  onCancel: () => void;
  onChange?: (changed: boolean) => void;
}) {
  const [initial] = useState(props.initial);
  const [v, setV] = useState(props.initial);
  const [attempted, setAttempted] = useState(false);
  const fieldEls = useRef(new Map<FormField, HTMLElement>());
  const saveRef = useRef<HTMLButtonElement>(null);
  const allDayLocked = props.mode.kind === 'edit' && props.mode.scope === 'all';
  const moveBlocked = props.mode.kind === 'edit' && props.mode.scope === 'all' ? props.mode.moveBlocked : null;
  const timesNote = moveBlocked ? 'event-times-note' : undefined;
  // A new repeat follows the start's weekday (M-8); an existing series' weekdays stay as they are.
  const follows = props.mode.kind === 'create' || (props.mode.scope === 'this' && !props.mode.instance);
  const moveStart = (startDate: string, startTime: string) => {
    const next = withStart(v, startDate, startTime);
    setV(follows ? followStartWeekday(v, next) : next);
  };

  // Locking disables the field that had focus, so focus goes to Save, which the notice names.
  useEffect(() => {
    if (props.locked) saveRef.current?.focus();
  }, [props.locked]);

  const onChange = props.onChange;
  const changed = formChanged(v, initial);
  useEffect(() => {
    onChange?.(changed);
  }, [changed, onChange]);

  const checked = toEventInput(v, props.mode, initial);
  const problem = attempted && 'error' in checked ? checked : null;
  const fields: FieldHooks = {
    invalid: (field) => (problem?.field === field ? { 'aria-invalid': true, 'aria-describedby': PROBLEM_ID } : {}),
    reg: (field) => (el) => {
      if (el) fieldEls.current.set(field, el);
      else fieldEls.current.delete(field);
    },
  };
  /** A date or time input's props: its own note, and the problem when it's this field's. */
  const timeField = (field: FormField) => ({
    ref: fields.reg(field),
    'aria-invalid': problem?.field === field ? true : undefined,
    'aria-describedby': ids(timesNote, problem?.field === field ? PROBLEM_ID : undefined),
  });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAttempted(true);
    if ('error' in checked) {
      fieldEls.current.get(checked.field)?.focus();
      return;
    }
    props.onSubmit(checked.input);
  }

  const error = problem?.error ?? props.error;
  const repeatStart = repeatStartFor(props.mode, initial, v);
  return (
    <form className="event-form" aria-labelledby={props.titleId} onSubmit={submit} noValidate>
      <h3 id={props.titleId}>{props.heading}</h3>
      {props.notice && <p className="notice" role="alert">{props.notice}</p>}
      {props.locked && <p className="notice" role="alert">{props.locked}</p>}
      <fieldset className="event-fields" disabled={!!props.locked}>
        <label>
          Title
          <input required autoFocus maxLength={1024} value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} {...fields.invalid('title')} ref={fields.reg('title')} />
        </label>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={v.allDay}
            // Locked rather than disabled, so it stays focusable and its note is read out.
            aria-disabled={allDayLocked || undefined}
            aria-describedby={allDayLocked ? 'event-all-day-note' : undefined}
            onChange={(e) => {
              if (!allDayLocked) setV(withAllDay(v, e.target.checked));
            }}
          />
          All day
        </label>
        {allDayLocked && <p id="event-all-day-note" className="muted todo-form-note">To change whether a repeating event is all day, change it in Google Calendar.</p>}
        <div className="form-row">
          <label>
            Starts
            <input type="date" required value={v.startDate} readOnly={!!moveBlocked} onChange={(e) => moveStart(e.target.value, v.startTime)} {...timeField('startDate')} />
          </label>
          {!v.allDay && (
            <label>
              Start time
              <input type="time" required value={v.startTime} readOnly={!!moveBlocked} onChange={(e) => moveStart(v.startDate, e.target.value)} {...timeField('startTime')} />
            </label>
          )}
          <label>
            Ends
            <input type="date" required value={v.endDate} min={v.startDate} readOnly={!!moveBlocked} onChange={(e) => setV({ ...v, endDate: e.target.value })} {...timeField('endDate')} />
          </label>
          {!v.allDay && (
            <label>
              End time
              <input type="time" required value={v.endTime} readOnly={!!moveBlocked} onChange={(e) => setV({ ...v, endTime: e.target.value })} {...timeField('endTime')} />
            </label>
          )}
        </div>
        {moveBlocked && <p id="event-times-note" className="notice todo-form-note">{moveBlocked}</p>}
        <p className="muted todo-form-note">Times are in {zoneName(props.timeZone)}.</p>
        <label>
          Location
          <input maxLength={1024} value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} />
        </label>
        <label>
          Description
          <textarea
            rows={3}
            maxLength={8192}
            value={v.description}
            readOnly={props.descriptionLocked}
            aria-describedby={props.descriptionLocked ? 'event-description-note' : undefined}
            onChange={(e) => setV({ ...v, description: e.target.value })}
          />
        </label>
        {props.descriptionLocked && (
          <p id="event-description-note" className="muted todo-form-note">This description is formatted in Google Calendar, so change it there.</p>
        )}
        <RepeatEditor
          value={v.repeat}
          onChange={(repeat) => setV({ ...v, repeat })}
          startDate={repeatStart}
          readOnly={props.repeatReadOnly}
          allowNone={!(props.mode.kind === 'edit' && props.mode.scope === 'all')}
          fields={fields}
        />
      </fieldset>
      {error && <p id={problem ? PROBLEM_ID : undefined} className="error" role="alert">{error}</p>}
      <div className="form-row">
        <button ref={saveRef} type="submit" className="primary" disabled={props.busy}>{props.busy ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={props.onCancel}>Cancel</button>
      </div>
    </form>
  );
}
