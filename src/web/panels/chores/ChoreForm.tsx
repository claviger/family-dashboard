import { useRef, useState, type FormEvent, type Ref } from 'react';
import {
  CHORE_NOTES_MAX, CHORE_TITLE_MAX, describeSchedule, WEEKDAY_LABELS, type ChoreInput, type ChorePeopleEntry, type NewChoreInput,
} from '../../../shared/chores.js';
import { formInput, scheduleProblem, showsStartDate, toSchedule, type ChoreFormValues, type ScheduleField } from './choreFormValues.js';
import { wontSeeChores, wontSeeWarning } from './format.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Add and edit form for a chore (spec §11.1, chore board spec "Frequencies"): every kind of schedule,
 * including as needed. `error` is shown inside the form, next to what was submitted.
 *
 * `assignTo` is for a new chore: who it can go to (a member: themselves; an admin: everyone active),
 * shown as "Who has it" with Unassigned first. An edit leaves it out, since who has a chore changes on
 * the Board, and its `onSubmit` gets a `ChoreInput` with no assignee. The start date shows only for
 * "every N weeks" (`showsStartDate`); while it's hidden, the initial one is saved (`formInput`).
 *
 * The schedule is checked here before submitting (the server checks it again): a problem keeps the
 * form from submitting and moves focus to the first field with it. The line under the schedule
 * shows the problem, and the fields with it point to that line (`aria-describedby`) and are marked
 * `aria-invalid`.
 */
export function ChoreForm(
  props: {
    name: string;
    initial: ChoreFormValues;
    submitLabel: string;
    busy: boolean;
    error?: string | null;
    titleRef?: Ref<HTMLInputElement>;
    onCancel: () => void;
  } & (
    | { assignTo: ChorePeopleEntry[]; onSubmit: (input: NewChoreInput) => void }
    | { assignTo?: undefined; onSubmit: (input: ChoreInput) => void }
  ),
) {
  const [v, setV] = useState(props.initial);
  const set = (patch: Partial<ChoreFormValues>) => setV((cur) => ({ ...cur, ...patch }));
  const problem = scheduleProblem(v);
  const fieldEls = useRef(new Map<ScheduleField, HTMLElement>());
  const assignee = props.assignTo?.find((p) => String(p.id) === v.assignee);
  const id = props.name.replace(/\W+/g, '-').toLowerCase();
  const scheduleNoteId = `${id}-schedule`;

  /** Props that tie a schedule input to the schedule line while it has a problem. */
  function invalid(field: ScheduleField) {
    const bad = problem?.fields.includes(field) ?? false;
    return { 'aria-invalid': bad || undefined, 'aria-describedby': bad ? scheduleNoteId : undefined };
  }
  function regField(field: ScheduleField) {
    return (el: HTMLElement | null) => {
      if (el) fieldEls.current.set(field, el);
      else fieldEls.current.delete(field);
    };
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (problem) {
      const first = problem.fields.map((f) => fieldEls.current.get(f)).find((el) => el !== undefined);
      first?.focus();
      return;
    }
    if (props.assignTo) props.onSubmit(formInput(v, props.initial, true));
    else props.onSubmit(formInput(v, props.initial, false));
  }

  return (
    <form className="todo-form form-row chore-form" aria-label={props.name} onSubmit={submit}>
      <label>
        Title
        <input ref={props.titleRef} required autoFocus maxLength={CHORE_TITLE_MAX} value={v.title} onChange={(e) => set({ title: e.target.value })} />
      </label>
      {props.assignTo && (
        <label>
          Who has it
          <select value={v.assignee} onChange={(e) => set({ assignee: e.target.value })} aria-describedby={wontSeeChores(assignee) ? `${id}-warning` : undefined}>
            <option value="">Unassigned (up for grabs)</option>
            {props.assignTo.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </select>
        </label>
      )}
      {assignee && wontSeeChores(assignee) && (
        <p id={`${id}-warning`} className="error chore-form-note">{wontSeeWarning(assignee.displayName)}</p>
      )}

      <fieldset className="panel-picks chore-form-note">
        <legend>How often</legend>
        <label className="inline-check">
          <input type="radio" name={`${id}-type`} checked={v.type === 'fixed'} onChange={() => set({ type: 'fixed' })} />
          On a schedule
        </label>
        <label className="inline-check">
          <input type="radio" name={`${id}-type`} checked={v.type === 'after'} onChange={() => set({ type: 'after' })} />
          After it's done
        </label>
        <label className="inline-check">
          <input type="radio" name={`${id}-type`} checked={v.type === 'none'} onChange={() => set({ type: 'none' })} />
          As needed
        </label>
      </fieldset>

      {v.type === 'fixed' && (
        <>
          <label>
            Repeats
            <select value={v.repeats} onChange={(e) => set({ repeats: e.target.value as ChoreFormValues['repeats'] })}>
              <option value="daily">Every day</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          {v.repeats === 'weekly' && (
            <>
              <label>
                Every how many weeks
                <input
                  ref={regField('interval')}
                  type="number"
                  inputMode="numeric"
                  required
                  min={1}
                  max={52}
                  value={v.interval}
                  onChange={(e) => set({ interval: e.target.value })}
                  {...invalid('interval')}
                />
              </label>
              <fieldset className="panel-picks chore-form-note">
                <legend>On</legend>
                {WEEKDAY_LABELS.map((label, day) => (
                  <label key={day} className="inline-check">
                    <input
                      ref={day === 0 ? regField('weekdays') : undefined}
                      type="checkbox"
                      aria-label={DAY_NAMES[day]}
                      {...invalid('weekdays')}
                      checked={v.weekdays.includes(day)}
                      onChange={(e) =>
                        set({ weekdays: e.target.checked ? [...v.weekdays, day].sort((a, b) => a - b) : v.weekdays.filter((d) => d !== day) })
                      }
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
            </>
          )}
          {v.repeats === 'monthly' && (
            <label>
              Day of the month
              <select ref={regField('monthDay')} value={v.monthDay} onChange={(e) => set({ monthDay: e.target.value })} {...invalid('monthDay')}>
                {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((d) => <option key={d} value={d}>{d}</option>)}
                <option value="last">Last day</option>
              </select>
            </label>
          )}
          {showsStartDate(v) && (
            <label>
              Starting the week of
              <input type="date" required value={v.startDate} onChange={(e) => set({ startDate: e.target.value })} />
            </label>
          )}
        </>
      )}
      {v.type === 'after' && (
        <>
          <label>
            Every
            <input
              ref={regField('every')}
              type="number"
              inputMode="numeric"
              required
              min={1}
              max={365}
              value={v.every}
              onChange={(e) => set({ every: e.target.value })}
              {...invalid('every')}
            />
          </label>
          <label>
            Unit
            <select ref={regField('unit')} value={v.unit} onChange={(e) => set({ unit: e.target.value as ChoreFormValues['unit'] })} {...invalid('unit')}>
              <option value="days">Days after it's done</option>
              <option value="weeks">Weeks after it's done</option>
            </select>
          </label>
        </>
      )}
      <p id={scheduleNoteId} className={problem ? 'error chore-form-note' : 'muted chore-form-note'} aria-live="polite">
        {problem ? problem.message : describeSchedule(toSchedule(v))}
      </p>
      <label className="todo-notes-field">
        Notes
        <textarea maxLength={CHORE_NOTES_MAX} rows={2} value={v.notes} onChange={(e) => set({ notes: e.target.value })} />
      </label>
      {props.error && <p className="error" role="alert">{props.error}</p>}
      <button type="submit" className="primary" disabled={props.busy}>{props.submitLabel}</button>
      <button type="button" onClick={props.onCancel}>Cancel</button>
    </form>
  );
}
