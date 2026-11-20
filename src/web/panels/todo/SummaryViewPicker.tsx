import { TODO_SUMMARY_VIEW_LABELS, TODO_SUMMARY_VIEWS, TodoSummaryViewSchema } from '../../../shared/todo.js';
import { useSaveTodoPrefs, useTodoPrefs } from './queries.js';

/**
 * Which items the home card shows (spec §10.3). It lives in personal settings (spec §7), and in
 * the drill-down too, next to the list it filters.
 */
export function SummaryViewPicker() {
  const prefs = useTodoPrefs();
  const save = useSaveTodoPrefs();
  if (!prefs.data) return null;
  return (
    <>
      <label>
        Home card shows
        <select
          value={save.isPending ? save.variables.summaryView : prefs.data.summaryView}
          disabled={save.isPending}
          onChange={(e) => save.mutate({ summaryView: TodoSummaryViewSchema.parse(e.target.value) })}
        >
          {TODO_SUMMARY_VIEWS.map((v) => <option key={v} value={v}>{TODO_SUMMARY_VIEW_LABELS[v]}</option>)}
        </select>
      </label>
      {save.error && <p className="error" role="alert">{save.error.message}</p>}
    </>
  );
}
