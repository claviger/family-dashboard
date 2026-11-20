import { useState, type FormEvent, type Ref } from 'react';
import type { CreateTodoInput, TodoItem, UpdateTodoInput } from '../../../shared/todo.js';

export interface TodoFormValues {
  title: string;
  notes: string;
  dueDate: string;
  dueTime: string;
}

export const EMPTY_TODO_FORM: TodoFormValues = { title: '', notes: '', dueDate: '', dueTime: '' };

export function toFormValues(item: TodoItem): TodoFormValues {
  return { title: item.title, notes: item.notes ?? '', dueDate: item.dueDate ?? '', dueTime: item.dueTime ?? '' };
}

/** Form values as an API body. Blank fields become null; a time without a date is dropped. */
export function toTodoInput(v: TodoFormValues): Required<CreateTodoInput> {
  return {
    title: v.title.trim(),
    notes: v.notes.trim() === '' ? null : v.notes,
    dueDate: v.dueDate || null,
    dueTime: v.dueDate && v.dueTime ? v.dueTime : null,
  };
}

/** An edit's patch. With the date locked (a task that repeats in Todoist), the due fields are left out, so they can't change. */
export function toTodoPatch(v: TodoFormValues, dateLocked: boolean): UpdateTodoInput {
  const { dueDate, dueTime, ...rest } = toTodoInput(v);
  return dateLocked ? rest : { ...rest, dueDate, dueTime };
}

/**
 * Add and edit form for the drill-down (spec §10.4). `name` labels the form for assistive tech.
 * `error` is shown inside the form, so it appears next to what was submitted.
 */
export function TodoForm(props: {
  name: string;
  initial: TodoFormValues;
  submitLabel: string;
  busy: boolean;
  error?: string | null;
  /** Focus the title field when the form mounts. */
  autoFocus?: boolean;
  titleRef?: Ref<HTMLInputElement>;
  /** Shown instead of letting the date change, e.g. for a task that repeats in Todoist. */
  dateLocked?: string;
  onSubmit: (values: TodoFormValues) => void;
  onCancel?: () => void;
}) {
  const [v, setV] = useState(props.initial);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    props.onSubmit(v);
  }

  return (
    <form className="todo-form form-row" aria-label={props.name} onSubmit={submit}>
      <label>
        Title
        <input ref={props.titleRef} required autoFocus={props.autoFocus} maxLength={500} value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} />
      </label>
      <label>
        Due date
        <input
          type="date"
          value={v.dueDate}
          // Read-only rather than disabled, so it stays focusable and its note is read out.
          readOnly={props.dateLocked !== undefined}
          aria-describedby={props.dateLocked !== undefined ? 'todo-date-locked' : undefined}
          onChange={(e) => setV({ ...v, dueDate: e.target.value, dueTime: e.target.value ? v.dueTime : '' })}
        />
      </label>
      <label>
        Due time
        <input
          type="time"
          value={v.dueTime}
          disabled={!v.dueDate && props.dateLocked === undefined}
          readOnly={props.dateLocked !== undefined}
          aria-describedby={props.dateLocked !== undefined ? 'todo-date-locked' : undefined}
          onChange={(e) => setV({ ...v, dueTime: e.target.value })}
        />
      </label>
      {props.dateLocked && <p id="todo-date-locked" className="muted todo-form-note">{props.dateLocked}</p>}
      <label className="todo-notes-field">
        Notes
        <textarea maxLength={10_000} rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
      </label>
      {props.error && <p className="error" role="alert">{props.error}</p>}
      <button type="submit" className="primary" disabled={props.busy}>{props.submitLabel}</button>
      {props.onCancel && <button type="button" onClick={props.onCancel}>Cancel</button>}
    </form>
  );
}
