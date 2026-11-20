import { addDays } from '../../../shared/dates.js';
import type { TodoGroupKey, TodoGroups, TodoItem, TodoSummaryView } from '../../../shared/todo.js';

type Dated = Pick<TodoItem, 'id' | 'dueDate' | 'dueTime' | 'createdAt'>;

/**
 * Which drill-down group an open item belongs to. `today` is the family-local date.
 * Date-based only: an item due today stays in Today all day, even after its due time.
 */
export function groupOf(item: Pick<TodoItem, 'dueDate'>, today: string): TodoGroupKey {
  if (item.dueDate === null) return 'none';
  if (item.dueDate < today) return 'overdue';
  if (item.dueDate === today) return 'today';
  return 'upcoming';
}

/**
 * Spec §10.3 order: dated items by due date (so overdue come first), then items with no date.
 * On the same date, timed items come first in time order, then untimed ones.
 * Ties fall back to creation time, then id.
 */
export function compareTodos(a: Dated, b: Dated): number {
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  if (a.dueTime !== b.dueTime) {
    if (a.dueTime === null) return 1;
    if (b.dueTime === null) return -1;
    return a.dueTime < b.dueTime ? -1 : 1;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id - b.id;
}

/** Whether an open item appears on the home card for `view`. */
export function inSummaryView(item: Pick<TodoItem, 'dueDate'>, view: TodoSummaryView, today: string): boolean {
  switch (view) {
    case 'overdue_today_undated':
      return item.dueDate === null || item.dueDate <= today;
    case 'overdue_today':
      return item.dueDate !== null && item.dueDate <= today;
    case 'next_7_days':
      return item.dueDate !== null && item.dueDate <= addDays(today, 6);
    case 'everything':
      return true;
  }
}

/** Groups open items for the drill-down, each group sorted with compareTodos. */
export function groupTodos(items: TodoItem[], today: string): TodoGroups {
  const groups: TodoGroups = { overdue: [], today: [], upcoming: [], none: [] };
  for (const item of [...items].sort(compareTodos)) groups[groupOf(item, today)].push(item);
  return groups;
}
