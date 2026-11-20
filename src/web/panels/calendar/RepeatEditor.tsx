import { WEEKDAY_NAMES, WEEKDAYS, type Weekday } from '../../../shared/rrule.js';
import { repeatChoices, type FormField, type RepeatChoice, type RepeatValues } from './eventFormValues.js';

/** Ties a field to the form's problem (`aria-invalid`, `aria-describedby`) and registers it for focus. */
export interface FieldHooks {
  invalid: (field: FormField) => { 'aria-invalid'?: true; 'aria-describedby'?: string };
  reg: (field: FormField) => (el: HTMLElement | null) => void;
}

/**
 * The repeat part of the event form (spec §9.4): none, daily, weekly on chosen weekdays, monthly
 * on the start's day, or yearly; ending never, on a date, or after N times. When the repeat can't
 * be changed here (`readOnly`, with the reason), it's shown as text instead. `allowNone: false`
 * ("All events") leaves out "Doesn't repeat" (R5-M2).
 */
export function RepeatEditor({ value, onChange, startDate, readOnly, allowNone, fields }: {
  value: RepeatValues;
  onChange: (v: RepeatValues) => void;
  /** The day monthly and yearly repeat on, and the earliest the repeat can end: the series' first day. */
  startDate: string;
  readOnly: { text: string | null; note: string } | null;
  allowNone: boolean;
  fields: FieldHooks;
}) {
  if (readOnly) {
    return (
      <div className="repeat-editor">
        <p className="repeat-readonly"><span className="muted">Repeat:</span> {readOnly.text ?? "Doesn't repeat"}</p>
        <p className="muted todo-form-note">{readOnly.note}</p>
      </div>
    );
  }
  const toggle = (day: Weekday) =>
    onChange({ ...value, weekdays: value.weekdays.includes(day) ? value.weekdays.filter((d) => d !== day) : [...value.weekdays, day] });
  return (
    <fieldset className="repeat-editor">
      <legend>Repeat</legend>
      <label>
        How often
        <select value={value.freq} onChange={(e) => onChange({ ...value, freq: e.target.value as RepeatChoice })}>
          {repeatChoices(startDate, { allowNone }).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </label>
      {value.freq === 'weekly' && (
        <fieldset className="panel-picks repeat-days" {...fields.invalid('weekdays')}>
          <legend>On</legend>
          {WEEKDAYS.map((day, i) => (
            <label key={day} className="inline-check">
              <input ref={i === 0 ? fields.reg('weekdays') : undefined} type="checkbox" checked={value.weekdays.includes(day)} onChange={() => toggle(day)} />
              {WEEKDAY_NAMES[day]}
            </label>
          ))}
        </fieldset>
      )}
      {value.freq !== 'none' && (
        <fieldset className="panel-picks repeat-end">
          <legend>Ends</legend>
          <label className="inline-check">
            <input type="radio" name="repeat-end" checked={value.endType === 'never'} onChange={() => onChange({ ...value, endType: 'never' })} />
            Never
          </label>
          <label className="inline-check">
            <input type="radio" name="repeat-end" checked={value.endType === 'on'} onChange={() => onChange({ ...value, endType: 'on' })} />
            On
          </label>
          <input
            ref={fields.reg('repeatEndDate')}
            type="date"
            aria-label="Last day it repeats"
            min={startDate}
            value={value.endDate}
            disabled={value.endType !== 'on'}
            onChange={(e) => onChange({ ...value, endDate: e.target.value })}
            {...fields.invalid('repeatEndDate')}
          />
          <label className="inline-check">
            <input type="radio" name="repeat-end" checked={value.endType === 'after'} onChange={() => onChange({ ...value, endType: 'after' })} />
            After
          </label>
          <input
            ref={fields.reg('repeatCount')}
            type="number"
            min={1}
            max={1000}
            inputMode="numeric"
            aria-label="How many times it happens"
            className="repeat-count"
            value={value.count}
            disabled={value.endType !== 'after'}
            onChange={(e) => onChange({ ...value, count: e.target.value })}
            {...fields.invalid('repeatCount')}
          />
          <span>times</span>
        </fieldset>
      )}
    </fieldset>
  );
}
